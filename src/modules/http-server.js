const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVER_INFO_PATH = path.join(os.homedir(), ".localkeys", "server-info.json");

class HttpServer {
    constructor(vault, logger) {
        this.vault = vault;
        this.logger = logger;
        this.server = null;
        this.port = 0;
        this.host = "localhost";
        this.isUnlocked = false;
        this.authToken = this.generateAuthToken();
        this.approvalCallback = null;
    }

    generateAuthToken() {
        return crypto.randomBytes(32).toString("hex");
    }

    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.listen(0, this.host, () => {
                this.port = this.server.address().port;

                try {
                    fs.mkdirSync(path.dirname(SERVER_INFO_PATH), { recursive: true });
                } catch {}

                fs.writeFileSync(
                    SERVER_INFO_PATH,
                    JSON.stringify({
                        host: this.host,
                        port: this.port,
                        authToken: this.authToken,
                        pid: process.pid,
                    })
                );

                try {
                    fs.chmodSync(SERVER_INFO_PATH, 0o600);
                } catch (error) {
                    console.error("Failed to set server-info.json permissions:", error.message);
                }

                resolve({
                    host: this.host,
                    port: this.port,
                    authToken: this.authToken,
                });
            });

            this.server.on("error", (error) => {
                reject(error);
            });
        });
    }

    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    if (fs.existsSync(SERVER_INFO_PATH)) {
                        fs.unlinkSync(SERVER_INFO_PATH);
                    }

                    resolve();
                });
            });
        }
    }

    authenticateRequest(req, res) {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Authorization required" }));
            return false;
        }

        const token = authHeader.substring(7);
        if (token !== this.authToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Invalid token" }));
            return false;
        }

        return true;
    }

    setCorsHeaders(res) {
        res.setHeader("Access-Control-Allow-Origin", "http://localhost");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    async handleRequest(req, res) {
        try {
            this.setCorsHeaders(res);

            if (req.method === "OPTIONS") {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method !== "POST") {
                res.writeHead(405, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Method not allowed" }));
                return;
            }

            if (!this.authenticateRequest(req, res)) {
                return;
            }

            const body = await this.parseRequestBody(req);
            const { action, data } = body;

            const result = await this.handleAction(action, data);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    success: false,
                    error: error.message,
                })
            );
        }
    }

    parseRequestBody(req) {
        return new Promise((resolve, reject) => {
            let body = "";

            req.on("data", (chunk) => {
                body += chunk.toString();
            });

            req.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error("Invalid JSON"));
                }
            });

            req.on("error", reject);
        });
    }

    async handleAction(action, data) {
        try {
            let result;

            switch (action) {
                case "listProjects":
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        result = { success: true, data: this.vault.getProjects() };
                    }
                    break;

                case "listSecretKeys":
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        const secrets = this.vault.getSecrets(data.projectName);
                        const keys = Object.keys(secrets);
                        result = { success: true, data: keys };
                    }
                    break;

                case "getBatchSecrets":
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        const approvalResult = await this.requestBatchApproval(data.projectName, data.keys);

                        if (approvalResult.approved) {
                            const secrets = {};
                            for (const key of data.keys) {
                                try {
                                    secrets[key] = this.vault.getSecret(data.projectName, key);
                                } catch (error) {}
                            }
                            result = { success: true, data: secrets };
                        } else {
                            const reason = approvalResult.reason || "User denied";
                            result = { success: false, error: `Access denied: ${reason}` };
                        }
                    }
                    break;

                case "getSecret":
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        const approvalResult = await this.requestBatchApproval(data.projectName, [data.key]);

                        if (approvalResult.approved) {
                            const value = this.vault.getSecret(data.projectName, data.key);
                            result = { success: true, data: value };
                        } else {
                            const reason = approvalResult.reason || "User denied";
                            result = { success: false, error: `Access denied: ${reason}` };
                        }
                    }
                    break;

                case "setSecret":
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        this.vault.setSecret(data.projectName, data.key, data.value);
                        result = { success: true };
                    }
                    break;

                case "status":
                    result = {
                        success: true,
                        data: {
                            isUnlocked: this.isUnlocked,
                            version: "1.0.0",
                        },
                    };
                    break;

                default:
                    result = { success: false, error: "Unknown action" };
            }

            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    setUnlocked(unlocked) {
        this.isUnlocked = unlocked;
        this.logger.logLock(`Vault ${unlocked ? "unlocked" : "locked"}`);
    }

    setApprovalCallback(callback) {
        this.approvalCallback = callback;
    }

    async requestBatchApproval(projectName, keys) {
        if (!this.approvalCallback) {
            return { approved: false, reason: "No approval handler available" };
        }

        return await this.approvalCallback(projectName, keys);
    }
}

module.exports = HttpServer;

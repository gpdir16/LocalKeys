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

                try {
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
                } catch (error) {
                    console.error("Failed to write server-info.json:", error.message);
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
                    try {
                        if (fs.existsSync(SERVER_INFO_PATH)) {
                            fs.unlinkSync(SERVER_INFO_PATH);
                        }
                    } catch {}

                    // 리소스 정리
                    this.server = null;
                    this.authToken = null;
                    this.port = 0;
                    this.isUnlocked = false;

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
        const expected = Buffer.from(this.authToken, "utf8");
        const received = Buffer.from(token, "utf8");
        if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
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
            const action = body && typeof body === "object" ? body.action : undefined;
            const data = body && typeof body === "object" ? body.data : undefined;

            const result = await this.handleAction(action, data);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
        } catch (error) {
            const statusCode = error?.message === "Request too large" ? 413 : 500;
            res.writeHead(statusCode, { "Content-Type": "application/json" });
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
            let totalLength = 0;
            const MAX_BODY_SIZE = 1024 * 1024; // 1MB

            req.on("data", (chunk) => {
                totalLength += chunk.length;
                if (totalLength > MAX_BODY_SIZE) {
                    req.destroy();
                    reject(new Error("Request too large"));
                    return;
                }
                body += chunk.toString("utf8");
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
            const safeData = data && typeof data === "object" && !Array.isArray(data) ? data : {};

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
                        const secrets = this.vault.getSecrets(safeData.projectName);
                        const keys = Object.keys(secrets);
                        if (keys.length === 0) {
                            result = { success: true, data: [] };
                        } else {
                            const approvalResult = await this.requestBatchApproval(safeData.projectName, keys, "read");
                            if (approvalResult.approved) {
                                result = { success: true, data: keys };
                            } else {
                                const reason = approvalResult.reason || "User denied";
                                result = { success: false, error: `Access denied: ${reason}` };
                            }
                        }
                    }
                    break;

                case "getAllSecrets":
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        const secrets = this.vault.getSecrets(safeData.projectName);
                        const keys = Object.keys(secrets);

                        if (keys.length === 0) {
                            result = { success: true, data: {} };
                        } else {
                            const approvalResult = await this.requestBatchApproval(safeData.projectName, keys, "read");

                            if (approvalResult.approved) {
                                result = { success: true, data: secrets };
                            } else {
                                const reason = approvalResult.reason || "User denied";
                                result = { success: false, error: `Access denied: ${reason}` };
                            }
                        }
                    }
                    break;

                case "getBatchSecrets":
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        const keys = Array.isArray(safeData.keys) ? safeData.keys.filter((k) => typeof k === "string") : [];
                        const approvalResult = await this.requestBatchApproval(safeData.projectName, keys, "read");

                        if (approvalResult.approved) {
                            const secrets = Object.create(null);
                            for (const key of keys) {
                                try {
                                    secrets[key] = this.vault.getSecret(safeData.projectName, key);
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
                        const approvalResult = await this.requestBatchApproval(safeData.projectName, [safeData.key], "read");

                        if (approvalResult.approved) {
                            const value = this.vault.getSecret(safeData.projectName, safeData.key);
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
                        const approvalResult = await this.requestBatchApproval(safeData.projectName, [safeData.key], "write");
                        if (approvalResult.approved) {
                            this.vault.setSecret(safeData.projectName, safeData.key, safeData.value);
                            result = { success: true };
                        } else {
                            const reason = approvalResult.reason || "User denied";
                            result = { success: false, error: `Access denied: ${reason}` };
                        }
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

    async requestBatchApproval(projectName, keys, action = "read") {
        if (!this.approvalCallback) {
            return { approved: false, reason: "No approval handler available" };
        }

        return await this.approvalCallback(projectName, keys, action);
    }
}

module.exports = HttpServer;

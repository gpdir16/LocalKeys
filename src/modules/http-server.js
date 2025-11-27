const http = require("http");
const crypto = require("crypto");

/**
 * HTTP 서버 모듈
 * CLI와 Electron 앱 간의 HTTP 통신 처리
 */
class HttpServer {
    constructor(vault, logger) {
        this.vault = vault;
        this.logger = logger;
        this.server = null;
        this.port = 0; // 랜덤 포트 할당
        this.host = "localhost";
        this.isUnlocked = false;
        this.authToken = this.generateAuthToken();
        this.approvalCallback = null; // 승인 다이얼로그 콜백
    }

    /**
     * 인증 토큰 생성
     */
    generateAuthToken() {
        return crypto.randomBytes(32).toString("hex");
    }

    /**
     * 서버 시작
     */
    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            // 랜덤 포트에서 서버 시작
            this.server.listen(0, this.host, () => {
                this.port = this.server.address().port;

                // 포트 정보를 파일에 저장 (CLI가 읽을 수 있도록)
                const fs = require("fs");
                const path = require("path");
                const infoPath = path.join(require("os").homedir(), ".localkeys", "server-info.json");

                fs.writeFileSync(
                    infoPath,
                    JSON.stringify({
                        host: this.host,
                        port: this.port,
                        authToken: this.authToken,
                        pid: process.pid,
                    })
                );

                // 파일 권한을 600으로 설정 (소유자만 읽기/쓰기)
                try {
                    fs.chmodSync(infoPath, 0o600);
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

    /**
     * 서버 중지
     */
    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    // 서버 정보 파일 삭제
                    const fs = require("fs");
                    const path = require("path");
                    const infoPath = path.join(require("os").homedir(), ".localkeys", "server-info.json");

                    if (fs.existsSync(infoPath)) {
                        fs.unlinkSync(infoPath);
                    }

                    resolve();
                });
            });
        }
    }

    /**
     * 인증 미들웨어
     */
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

    /**
     * CORS 헤더 설정 (localhost만 허용)
     */
    setCorsHeaders(res) {
        res.setHeader("Access-Control-Allow-Origin", "http://localhost");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    /**
     * 요청 처리
     */
    async handleRequest(req, res) {
        try {
            this.setCorsHeaders(res);

            // OPTIONS 요청 처리 (CORS preflight)
            if (req.method === "OPTIONS") {
                res.writeHead(200);
                res.end();
                return;
            }

            // POST 요청만 허용
            if (req.method !== "POST") {
                res.writeHead(405, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Method not allowed" }));
                return;
            }

            // 인증 확인
            if (!this.authenticateRequest(req, res)) {
                return;
            }

            // 요청 바디 파싱
            const body = await this.parseRequestBody(req);
            const { action, data } = body;

            // 요청 처리
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

    /**
     * 요청 바디 파싱
     */
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

    /**
     * 액션 처리
     */
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
                    // 프로젝트의 시크릿 키 목록만 반환 (값은 반환하지 않음)
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        const secrets = this.vault.getSecrets(data.projectName);
                        const keys = Object.keys(secrets);
                        result = { success: true, data: keys };
                    }
                    break;

                case "getBatchSecrets":
                    // 여러 시크릿을 한번에 승인 요청
                    if (!this.isUnlocked) {
                        result = { success: false, error: "Vault is locked" };
                    } else {
                        // 승인 다이얼로그 표시 (여러 키를 함께 표시)
                        const approvalResult = await this.requestBatchApproval(data.projectName, data.keys);

                        if (approvalResult.approved) {
                            const secrets = {};
                            for (const key of data.keys) {
                                try {
                                    secrets[key] = this.vault.getSecret(data.projectName, key);
                                } catch (error) {
                                    // 존재하지 않는 키는 무시
                                }
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
                        // 승인 다이얼로그 표시
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

    /**
     * 잠금 해제 상태 설정
     */
    setUnlocked(unlocked) {
        this.isUnlocked = unlocked;
        this.logger.logLock(`Vault ${unlocked ? "unlocked" : "locked"}`);
    }

    /**
     * 승인 콜백 설정
     */
    setApprovalCallback(callback) {
        this.approvalCallback = callback;
    }

    /**
     * 배치 승인 요청 처리
     */
    async requestBatchApproval(projectName, keys) {
        if (!this.approvalCallback) {
            // 승인 콜백이 없으면 기본적으로 거부
            return { approved: false, reason: "No approval handler available" };
        }

        return await this.approvalCallback(projectName, keys);
    }
}

module.exports = HttpServer;

#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

// CLI 인자 파싱
const args = process.argv.slice(2);
const command = args[0];

// LocalKeys 데이터 디렉토리
const LOCALKEYS_DIR = path.join(os.homedir(), ".localkeys");
const SERVER_INFO_PATH = path.join(LOCALKEYS_DIR, "server-info.json");

// 도움말 표시
function showHelp() {
    console.log(`
LocalKeys

Usage:
  localkeys <command> [options]

Commands:
  run --project=<name> <command>    Run command with environment variables
  get <project> <key>               Get a secret value
  set <project> <key> <value>       Set a secret value
  list                              List all projects
  help                              Show this help message

Examples:
  localkeys run --project=myapp -- npm start
  localkeys get myapp API_KEY
  localkeys set myapp API_KEY "sk-1234567890"
  localkeys list
`);
}

// 서버 정보 읽기
function getServerInfo() {
    try {
        if (!fs.existsSync(SERVER_INFO_PATH)) {
            return null;
        }

        const info = JSON.parse(fs.readFileSync(SERVER_INFO_PATH, "utf8"));

        // 프로세스가 실행 중인지 확인
        try {
            process.kill(info.pid, 0); // 시그널 0으로 프로세스 존재 확인
            return info;
        } catch (error) {
            // 프로세스가 존재하지 않으면 서버 정보 파일 삭제
            if (fs.existsSync(SERVER_INFO_PATH)) {
                fs.unlinkSync(SERVER_INFO_PATH);
            }
            return null;
        }
    } catch (error) {
        return null;
    }
}

// Electron 앱이 실행 중인지 확인
function isElectronAppRunning() {
    return new Promise((resolve) => {
        const serverInfo = getServerInfo();
        resolve(serverInfo !== null);
    });
}

// HTTP 요청 전송
async function sendRequest(action, data = {}) {
    const serverInfo = getServerInfo();

    if (!serverInfo) {
        throw new Error("Error: LocalKeys app is not running.");
    }

    return new Promise((resolve, reject) => {
        const requestData = JSON.stringify({
            action,
            data,
            timestamp: new Date().toISOString(),
        });

        const options = {
            hostname: serverInfo.host,
            port: serverInfo.port,
            path: "/",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(requestData),
                Authorization: `Bearer ${serverInfo.authToken}`,
            },
        };

        const req = http.request(options, (res) => {
            let responseData = "";

            res.on("data", (chunk) => {
                responseData += chunk;
            });

            res.on("end", () => {
                try {
                    const response = JSON.parse(responseData);

                    if (res.statusCode === 200) {
                        resolve(response);
                    } else {
                        reject(new Error(response.error || `Error: ERROR-${res.statusCode}`));
                    }
                } catch (error) {
                    reject(new Error(`Error: ERROR-${error.message}`));
                }
            });
        });

        req.on("error", (error) => {
            reject(new Error(`Error: ERROR-${error.message}`));
        });

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error("Error: Request timed out"));
        });

        req.write(requestData);
        req.end();
    });
}

// run 명령어 처리
async function handleRun() {
    const projectIndex = args.findIndex((arg) => arg.startsWith("--project="));
    if (projectIndex === -1) {
        console.error("Error: --project flag is required");
        process.exit(1);
    }

    const projectName = args[projectIndex].split("=")[1];
    let commandToRun = args.slice(projectIndex + 1);

    // -- 구분자 제거
    const separatorIndex = commandToRun.indexOf("--");
    if (separatorIndex !== -1) {
        commandToRun = commandToRun.slice(separatorIndex + 1);
    }

    if (commandToRun.length === 0) {
        console.error("Error: No command to run");
        process.exit(1);
    }

    try {
        // 프로젝트의 시크릿 키 목록 가져오기 (값은 가져오지 않음)
        const response = await sendRequest("listSecretKeys", { projectName });

        if (!response.success) {
            console.error(`Error: ${response.error}`);
            process.exit(1);
        }

        const secretKeys = response.data;

        if (secretKeys.length === 0) {
            console.log(`No secrets found in project "${projectName}". Running command without environment variables...`);
        } else {
            console.log(`Requesting approval for ${secretKeys.length} secret(s) from project "${projectName}"...`);
            console.log(`Keys: ${secretKeys.join(", ")}`);
        }

        // 모든 시크릿을 한번에 승인 요청 (배치 승인)
        let secrets = {};
        if (secretKeys.length > 0) {
            try {
                const batchResponse = await sendRequest("getBatchSecrets", { projectName, keys: secretKeys });

                if (batchResponse.success) {
                    secrets = batchResponse.data;
                    console.log(`✓ Approved: All secrets`);
                } else {
                    console.log(`✗ Denied: ${batchResponse.error}`);
                }
            } catch (error) {
                console.log(`✗ Failed: ${error.message}`);
            }
        }

        const approvedCount = Object.keys(secrets).length;
        if (approvedCount === 0 && secretKeys.length > 0) {
            console.error("\nError: Secrets were not approved. Cannot run command.");
            process.exit(1);
        }

        if (approvedCount > 0) {
            console.log(`${approvedCount} secret(s) approved.`);
        }

        // 환경변수 설정하여 명령 실행
        const env = { ...process.env };
        Object.entries(secrets).forEach(([key, value]) => {
            env[key] = value;
        });

        const [cmd, ...cmdArgs] = commandToRun;

        console.log(`\nRunning command: ${commandToRun.join(" ")}\n`);

        const child = spawn(cmd, cmdArgs, {
            env,
            stdio: "inherit",
            shell: true, // 셸을 통해 실행하여 npm 같은 명령어도 잘 작동하도록
        });

        child.on("exit", (code) => {
            process.exit(code);
        });
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// get 명령어 처리
async function handleGet() {
    if (args.length < 3) {
        console.error("Usage: localkeys get <project> <key>");
        process.exit(1);
    }

    const [projectName, key] = args.slice(1);

    try {
        const response = await sendRequest("getSecret", { projectName, key });

        if (response.success) {
            console.log(response.data);
        } else {
            console.error(`Error: ${response.error}`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// set 명령어 처리
async function handleSet() {
    if (args.length < 4) {
        console.error("Usage: localkeys set <project> <key> <value>");
        process.exit(1);
    }

    const [projectName, key, value] = args.slice(1);

    try {
        const response = await sendRequest("setSecret", { projectName, key, value });

        if (response.success) {
            console.log(`Secret "${key}" set successfully in project "${projectName}"`);
        } else {
            console.error(`Error: ${response.error}`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// list 명령어 처리
async function handleList() {
    try {
        const response = await sendRequest("listProjects");

        if (response.success) {
            const projects = response.data;

            if (projects.length === 0) {
                console.log("No projects found");
            } else {
                console.log("Projects:");
                projects.forEach((project) => {
                    console.log(`  ${project.name} (${project.secretCount} secrets)`);
                });
            }
        } else {
            console.error(`Error: ${response.error}`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// 메인 함수
async function main() {
    // 데이터 디렉토리 확인
    if (!fs.existsSync(LOCALKEYS_DIR)) {
        console.error("Error: LocalKeys is not set up. Please run the GUI application first.");
        process.exit(1);
    }

    // Electron 앱 실행 확인
    const isRunning = await isElectronAppRunning();

    if (!isRunning) {
        console.error("Error: LocalKeys app is not running. Please start the GUI application first.");
        process.exit(1);
    }

    // 명령어 처리
    switch (command) {
        case "run":
            await handleRun();
            break;
        case "get":
            await handleGet();
            break;
        case "set":
            await handleSet();
            break;
        case "list":
            await handleList();
            break;
        case "help":
        case "--help":
        case "-h":
            showHelp();
            break;
        default:
            console.error(`Unknown command: ${command}`);
            showHelp();
            process.exit(1);
    }
}

// 오류 처리
process.on("uncaughtException", (error) => {
    console.error(`Uncaught exception: ${error.message}`);
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    console.error(`Unhandled rejection: ${reason}`);
    process.exit(1);
});

// 실행
if (require.main === module) {
    main().catch((error) => {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    isElectronAppRunning,
    sendRequest,
    getServerInfo,
};

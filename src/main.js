const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// LocalKeys 코어 모듈
const Vault = require("./modules/vault");
const Logger = require("./modules/logger");
const HttpServer = require("./modules/http-server");

// 전역 변수
let mainWindow = null;
let vault = null;
let logger = null;
let httpServer = null;
let isUnlocked = false;
let autoLockTimer = null;
let tray = null;
let isQuitting = false;

// LocalKeys 데이터 디렉토리 경로
const LOCALKEYS_DIR = path.join(require("os").homedir(), ".localkeys");

// 트레이 아이콘 생성
function createTray() {
    // 트레이 아이콘이 이미 있으면 제거
    if (tray) {
        tray.destroy();
    }

    // macOS 트레이 아이콘 생성 - 템플릿 이미지로 설정
    const { nativeImage } = require("electron");
    const path = require("path");

    // 에셋 아이콘 파일 사용
    const iconPath = path.join(__dirname, "assets", "icon.png");
    let iconImage;

    try {
        // 아이콘 파일 로드
        iconImage = nativeImage.createFromPath(iconPath);

        // 트레이 아이콘 생성
        tray = new Tray(iconImage);

        // macOS에서 트레이 아이콘을 템플릿 이미지로 설정 (다크/라이트 모드 지원)
        if (process.platform === "darwin") {
            tray.setImage(iconImage.resize({ width: 16, height: 16 }));
        }
    } catch (error) {
        console.error("트레이 아이콘 생성 실패:", error);

        // 실패 시 빈 아이콘으로 대체
        try {
            iconImage = nativeImage.createEmpty();
            tray = new Tray(iconImage);

            if (process.platform === "darwin") {
                tray.setImage(iconImage.resize({ width: 16, height: 16 }));
            }
        } catch (fallbackError) {
            console.error("대체 아이콘 생성 실패:", fallbackError);
            return;
        }
    }

    // 트레이 메뉴 생성
    const contextMenu = Menu.buildFromTemplate([
        {
            label: "Show LocalKeys",
            click: () => {
                // macOS에서 Dock 아이콘 다시 보이기
                if (process.platform === "darwin") {
                    app.dock.show();
                }

                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    createWindow();
                }
            },
        },
        {
            label: "Lock Vault",
            click: () => {
                if (isUnlocked) {
                    lockVault();
                }
            },
        },
        { type: "separator" },
        {
            label: "Quit",
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setToolTip("LocalKeys");
    tray.setContextMenu(contextMenu);
}

// 앱 초기화
function initializeApp() {
    // 데이터 디렉토리 생성
    if (!fs.existsSync(LOCALKEYS_DIR)) {
        fs.mkdirSync(LOCALKEYS_DIR, { recursive: true });
    }

    // 로거 초기화
    logger = new Logger(path.join(LOCALKEYS_DIR, "logs.enc"));

    // Vault 초기화
    vault = new Vault(LOCALKEYS_DIR);

    // HTTP 서버 초기화
    httpServer = new HttpServer(vault, logger);

    // 승인 콜백 설정
    httpServer.setApprovalCallback(showApprovalDialog);

    // 트레이 아이콘 생성
    createTray();

    // CLI 자동 설치 시도 (백그라운드에서 조용히)
    try {
        const { spawn } = require("child_process");
        const path = require("path");
        const os = require("os");
        const cliPath = path.join(__dirname, "..", "cli", "localkeys.js");

        // CLI 파일이 존재하면 자동으로 설치 시도
        if (fs.existsSync(cliPath)) {
            // 실행 권한 부여 (Unix 계열만)
            if (os.platform() !== "win32") {
                try {
                    fs.chmodSync(cliPath, "755");
                } catch (error) {
                    // 권한 설정 실패 시 무시
                }
            }

            // 독립 CLI 자동 설치 시도 (silent)
            try {
                const cliPath = path.join(__dirname, "..", "cli", "localkeys.js");
                const createStandaloneCli = (cliJsPath, electronPath) => {
                    if (os.platform() === "win32") {
                        return `@echo off
set ELECTRON_RUN_AS_NODE=1
"${electronPath}" "${cliJsPath}" %*`;
                    } else {
                        return `#!/bin/bash
ELECTRON_RUN_AS_NODE=1 "${electronPath}" "${cliJsPath}" "$@"`;
                    }
                };

                const homeDir = os.homedir();
                let targetDir = null;

                if (os.platform() === "win32") {
                    targetDir = path.join(homeDir, "bin");
                } else {
                    targetDir = path.join(homeDir, ".local", "bin");
                }

                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }

                const targetPath = path.join(targetDir, os.platform() === "win32" ? "localkeys.cmd" : "localkeys");
                const standaloneContent = createStandaloneCli(cliPath, process.execPath);

                fs.writeFileSync(targetPath, standaloneContent);

                if (os.platform() !== "win32") {
                    fs.chmodSync(targetPath, "755");
                }
            } catch (error) {
                // 설치 실패 시 무시
            }
        }
    } catch (error) {
        // CLI 자동 설치 실패 시 무시
    }
}

// 자동 잠금 타이머 설정
function setAutoLockTimer() {
    if (autoLockTimer) {
        clearTimeout(autoLockTimer);
    }

    autoLockTimer = setTimeout(() => {
        if (isUnlocked) {
            lockVault();
        }
    }, 5 * 60 * 1000); // 5분
}

// Vault 잠금
function lockVault() {
    if (isUnlocked && vault) {
        // 실제 Vault 잠금 상태 확인
        if (!vault.isLocked) {
            // Logger 암호화 키 제거
            if (logger) {
                logger.clearEncryptionKey();
            }

            vault.lock();
        }

        isUnlocked = false;

        // HTTP 서버 상태 업데이트
        if (httpServer) {
            httpServer.setUnlocked(false);
        }

        if (mainWindow) {
            mainWindow.loadFile("src/views/lock.html");
        }

        logger.logLock("Vault auto-locked");
    }
}

// 윈도우 생성
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
        titleBarStyle: "default", // 운영체제 기본 윈도우 메뉴바 사용
        show: false,
        icon: path.join(__dirname, "assets", "icon.png"),
    });

    // 화면 결정 - Vault 상태에 따라 동적으로 결정
    if (!vault.exists()) {
        // 처음 설치 시 설정 화면
        mainWindow.loadFile("src/views/setup.html");
    } else if (isUnlocked && !vault.isLocked) {
        // Vault가 이미 잠금 해제된 상태면 대시보드 표시
        mainWindow.loadFile("src/views/dashboard.html");
        logger.logLock("Vault already unlocked - showing dashboard");
    } else {
        // Vault가 잠겨있으면 잠금 화면 표시
        mainWindow.loadFile("src/views/lock.html");
    }

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    // 창 닫을 때 이벤트 처리 (백그라운드 유지)
    mainWindow.on("close", (event) => {
        // 앱 종료 중이 아니면 백그라운드 모드 유지
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();

            // macOS에서 창을 닫으면 Dock 아이콘 숨기기
            if (process.platform === "darwin") {
                app.dock.hide();
            }
        }
    });

    // 창이 파괴되었을 때 처리
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

// IPC 핸들러 설정
function setupIpcHandlers() {
    // Vault 설정
    ipcMain.handle("vault:setup", async (event, password) => {
        try {
            await vault.setup(password);

            // Vault 상태 동기화
            isUnlocked = !vault.isLocked;
            setAutoLockTimer();

            // Logger 암호화 키 설정
            if (logger && vault.key) {
                logger.setEncryptionKey(vault.key);
            }

            // HTTP 서버 상태 업데이트
            if (httpServer) {
                httpServer.setUnlocked(isUnlocked);
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Vault 잠금 해제
    ipcMain.handle("vault:unlock", async (event, password) => {
        try {
            await vault.unlock(password);

            // Vault 상태 동기화
            isUnlocked = !vault.isLocked;
            setAutoLockTimer();

            // Logger 암호화 키 설정
            if (logger && vault.key) {
                logger.setEncryptionKey(vault.key);
            }

            // HTTP 서버 상태 업데이트
            if (httpServer) {
                httpServer.setUnlocked(isUnlocked);
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Vault 잠금
    ipcMain.handle("vault:lock", () => {
        lockVault();
        return { success: true };
    });

    // 프로젝트 목록 가져오기
    ipcMain.handle("projects:get", () => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        return { success: true, data: vault.getProjects() };
    });

    // 프로젝트 생성
    ipcMain.handle("project:create", async (event, name) => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        try {
            vault.createProject(name);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 프로젝트 삭제
    ipcMain.handle("project:delete", async (event, name) => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        try {
            vault.deleteProject(name);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 시크릿 목록 가져오기
    ipcMain.handle("secrets:get", (event, projectName) => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        return { success: true, data: vault.getSecrets(projectName) };
    });

    // 시크릿 저장
    ipcMain.handle("secret:set", async (event, projectName, key, value) => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        try {
            vault.setSecret(projectName, key, value);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 시크릿 삭제
    ipcMain.handle("secret:delete", async (event, projectName, key) => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        try {
            vault.deleteSecret(projectName, key);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 시크릿 조회 (승인 필요)
    ipcMain.handle("secret:get", async (event, projectName, key) => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };

        // 승인 다이얼로그 표시
        const result = await showApprovalDialog(projectName, key);

        if (result.approved) {
            const value = vault.getSecret(projectName, key);
            return { success: true, data: value };
        } else {
            return { success: false, error: "Access denied" };
        }
    });

    // 로그 가져오기
    ipcMain.handle("logs:get", () => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        return { success: true, data: logger.getLogs() };
    });

    // 로그 삭제
    ipcMain.handle("logs:clear", () => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        try {
            logger.clearLogs();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // .env 파일로 내보내기
    ipcMain.handle("secrets:export", async (event, projectName) => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };

        const result = await dialog.showSaveDialog(mainWindow, {
            defaultPath: `${projectName}.env`,
            filters: [{ name: "Environment Files", extensions: ["env"] }],
        });

        if (!result.canceled) {
            const secrets = vault.getSecrets(projectName);
            const envContent = Object.entries(secrets)
                .map(([key, value]) => `${key}=${value}`)
                .join("\n");

            fs.writeFileSync(result.filePath, envContent);
            logger.logApp(`Secrets exported: ${projectName} -> ${result.filePath}`);
            return { success: true, path: result.filePath };
        }

        return { success: false, error: "Export cancelled" };
    });

    // 화면 전환
    ipcMain.handle("navigate", (event, page) => {
        if (page === "dashboard" && isUnlocked) {
            mainWindow.loadFile("src/views/dashboard.html");
        } else if (page === "setup") {
            mainWindow.loadFile("src/views/setup.html");
        } else if (page === "lock") {
            lockVault();
        }
        return { success: true };
    });

    // 앱 종료
    ipcMain.handle("app:quit", async () => {
        isQuitting = true;
        app.quit();
        return { success: true };
    });

    // Vault 즉시 저장
    ipcMain.handle("vault:save", async () => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        try {
            await vault.saveNow();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // CLI 설치
    ipcMain.handle("cli:install", async () => {
        const fs = require("fs");
        const path = require("path");
        const os = require("os");

        try {
            const cliPath = path.join(__dirname, "..", "cli", "localkeys.js");
            if (!fs.existsSync(cliPath)) {
                return { success: false, error: "CLI file not found" };
            }

            // Unix 권한 설정
            if (os.platform() !== "win32") {
                try { fs.chmodSync(cliPath, "755"); } catch {}
            }

            // CLI 생성 함수
            const createCliScript = (electronPath) => os.platform() === "win32"
                ? `@echo off\nset ELECTRON_RUN_AS_NODE=1\n"${electronPath}" "${cliPath}" %*`
                : `#!/bin/bash\nELECTRON_RUN_AS_NODE=1 "${electronPath}" "${cliPath}" "$@"`;

            // 설치 경로 목록
            const homeDir = os.homedir();
            const installPaths = os.platform() === "win32"
                ? [
                    path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "Microsoft", "WindowsApps"),
                    path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "npm"),
                    path.join(homeDir, "bin")
                ]
                : [path.join(homeDir, ".local", "bin")];

            // PATH에서 추가 사용자 디렉토리 찾기
            const pathEnv = process.env.PATH || "";
            const pathSeparator = os.platform() === "win32" ? ';' : ':';
            for (const dir of pathEnv.split(pathSeparator)) {
                if (dir && fs.existsSync(dir) && dir.includes(homeDir) && !installPaths.includes(dir)) {
                    installPaths.push(dir);
                }
            }

            // 설치 시도
            for (const dir of installPaths) {
                try {
                    if (!fs.existsSync(dir)) {
                        if (dir === path.join(homeDir, ".local", "bin")) {
                            fs.mkdirSync(dir, { recursive: true });
                        } else {
                            continue;
                        }
                    }

                    // 쓰기 권한 확인
                    const testFile = path.join(dir, ".localkeys-test");
                    fs.writeFileSync(testFile, "test");
                    fs.unlinkSync(testFile);

                    const cliName = os.platform() === "win32" ? "localkeys.cmd" : "localkeys";
                    const targetPath = path.join(dir, cliName);

                    // 기존 파일 제거
                    if (fs.existsSync(targetPath)) {
                        fs.unlinkSync(targetPath);
                    }

                    // CLI 스크립트 생성
                    fs.writeFileSync(targetPath, createCliScript(process.execPath));

                    // 실행 권한 설정
                    try { fs.chmodSync(targetPath, "755"); } catch {}

                    const pathInfo = ` at ${targetPath}`;

                    // 맥/리눅스에서 PATH 자동 추가
                    if (os.platform() !== "win32") {
                        try {
                            const homeDir = os.homedir();
                            const shellConfigs = [
                                path.join(homeDir, ".zshrc"),
                                path.join(homeDir, ".bashrc"),
                                path.join(homeDir, ".bash_profile"),
                                path.join(homeDir, ".profile")
                            ];

                            const localBinPath = path.join(homeDir, ".local", "bin");
                            const pathLine = `\n# LocalKeys CLI\nexport PATH="$PATH:${localBinPath}"\n`;

                            let configFileUpdated = false;
                            let updatedConfig = null;

                            for (const configPath of shellConfigs) {
                                try {
                                    if (fs.existsSync(configPath)) {
                                        const content = fs.readFileSync(configPath, 'utf8');

                                        // 이미 PATH가 추가되어 있는지 확인
                                        if (!content.includes(localBinPath)) {
                                            fs.appendFileSync(configPath, pathLine);
                                            configFileUpdated = true;
                                            updatedConfig = path.basename(configPath);
                                            break;
                                        }
                                    }
                                } catch (error) {
                                    // 다음 파일 시도
                                    continue;
                                }
                            }

                            if (configFileUpdated) {
                                return {
                                    success: true,
                                    message: `CLI installed successfully${pathInfo}. Please restart your terminal.`
                                };
                            } else {
                                return {
                                    success: true,
                                    message: `CLI installed successfully${pathInfo}. But terminal setup failed. Please add ~/.local/bin to your PATH manually.`
                                };
                            }
                        } catch (error) {
                            // PATH 추가 실패해도 CLI 설치는 성공
                            return {
                                success: true,
                                message: `CLI installed successfully${pathInfo}. But terminal setup failed. Please add ~/.local/bin to your PATH manually.`
                            };
                        }
                    }

                    return { success: true, message: `CLI installed successfully${pathInfo}` };
                } catch {
                    continue;
                }
            }

            return { success: false, error: "CLI installation failed: Cannot find suitable path" };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // CLI 설치 상태 확인
    ipcMain.handle("cli:check", async () => {
        try {
            const fs = require("fs");
            const path = require("path");
            const os = require("os");

            // PATH 환경변수에서 CLI 파일 직접 확인
            const checkCliInPath = () => {
                try {
                    const pathEnv = process.env.PATH || "";
                    const pathSeparator = os.platform() === "win32" ? ';' : ':';
                    const pathDirs = pathEnv.split(pathSeparator);

                    const cliNames = os.platform() === "win32"
                        ? ["localkeys.cmd", "localkeys.bat", "localkeys.exe", "localkeys"]
                        : ["localkeys"];

                    for (const dir of pathDirs) {
                        if (!dir || !fs.existsSync(dir)) continue;

                        for (const cliName of cliNames) {
                            const cliPath = path.join(dir, cliName);
                            if (fs.existsSync(cliPath)) {
                                return { installed: true, path: cliPath };
                            }
                        }
                    }

                    return { installed: false };
                } catch (error) {
                    return { installed: false };
                }
            };

            return checkCliInPath();
        } catch (error) {
            return { installed: false };
        }
    });

    // CLI 제거
    ipcMain.handle("cli:uninstall", async () => {
        try {
            const fs = require("fs");
            const path = require("path");
            const os = require("os");

            // PATH에서 직접 CLI 파일 찾아서 제거
            const findAndRemoveCli = () => {
                try {
                    const pathEnv = process.env.PATH || "";
                    const pathSeparator = os.platform() === "win32" ? ';' : ':';
                    const pathDirs = pathEnv.split(pathSeparator);

                    const cliNames = os.platform() === "win32"
                        ? ["localkeys.cmd", "localkeys.bat", "localkeys.exe", "localkeys"]
                        : ["localkeys"];

                    let removed = false;
                    const removedPaths = [];

                    for (const dir of pathDirs) {
                        if (!dir || !fs.existsSync(dir)) continue;

                        for (const cliName of cliNames) {
                            const cliPath = path.join(dir, cliName);
                            if (fs.existsSync(cliPath)) {
                                try {
                                    fs.unlinkSync(cliPath);
                                    removed = true;
                                    removedPaths.push(cliPath);
                                    console.log(`Removed CLI from: ${cliPath}`);
                                } catch (error) {
                                    console.log(`Failed to remove ${cliPath}: ${error.message}`);
                                }
                            }
                        }
                    }

                    // Windows에서 추가 가능한 파일들 확인
                    if (os.platform() === "win32") {
                        const extraDirs = [
                            path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "WindowsApps"),
                            path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm")
                        ];

                        for (const dir of extraDirs) {
                            if (!fs.existsSync(dir)) continue;

                            for (const cliName of ["localkeys.cmd", "localkeys.bat", "localkeys.ps1"]) {
                                const cliPath = path.join(dir, cliName);
                                if (fs.existsSync(cliPath)) {
                                    try {
                                        fs.unlinkSync(cliPath);
                                        removed = true;
                                        removedPaths.push(cliPath);
                                        console.log(`Removed CLI from: ${cliPath}`);
                                    } catch (error) {
                                        console.log(`Failed to remove ${cliPath}: ${error.message}`);
                                    }
                                }
                            }
                        }
                    }

                    return { removed, removedPaths };
                } catch (error) {
                    console.log(`Error during CLI removal: ${error.message}`);
                    return { removed: false, removedPaths: [] };
                }
            };

            const result = findAndRemoveCli();

            if (result.removed) {
                return {
                    success: true,
                    message: `CLI uninstalled successfully from ${result.removedPaths.length} location(s)`
                };
            } else {
                return {
                    success: true,
                    message: "CLI not found in PATH. Already uninstalled or not installed."
                };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

// 승인 다이얼로그 표시
function showApprovalDialog(projectName, key) {
    return new Promise((resolve) => {
        let approvalWindow = null;
        let timeout = null;
        let isResolved = false;

        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (approvalWindow && !approvalWindow.isDestroyed()) {
                approvalWindow.close();
                approvalWindow = null;
            }
        };

        const doResolve = (result) => {
            if (isResolved) return; // 이미 처리됨
            isResolved = true;
            cleanup();
            resolve(result);
        };

        try {
            approvalWindow = new BrowserWindow({
                width: 450,
                height: 330,
                parent: mainWindow,
                modal: true,
                frame: false,
                alwaysOnTop: true,
                resizable: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, "preload.js"),
                },
                icon: path.join(__dirname, "assets", "icon.png"),
            });

            // 로그 기록

            approvalWindow.loadFile("src/views/approval.html");

            // 타임아웃 설정 (30초)
            timeout = setTimeout(() => {
                logger.logAccess("Access denied", projectName, key);
                doResolve({ approved: false, reason: "Timeout after 30 seconds" });
            }, 30000);

            // 간단한 IPC 핸들러 사용
            const channelName = "approval-response-simple";

            // 이전 핸들러 제거 (있을 경우)
            if (ipcMain.listenerCount(channelName) > 0) {
                ipcMain.removeAllListeners(channelName);
            }

            ipcMain.once(channelName, (event, approved) => {
                if (approved) {
                    logger.logAccess("Access approved", projectName, key);
                    doResolve({ approved: true });
                } else {
                    logger.logAccess("Access denied", projectName, key);
                    doResolve({ approved: false, reason: "User denied" });
                }
            });

            // 창 닫기 이벤트 처리 (사용자가 X 버튼 클릭 시)
            approvalWindow.on("close", () => {
                if (!isResolved) {
                    logger.logAccess("Access denied", projectName, key);
                    doResolve({ approved: false, reason: "Dialog closed" });
                }
            });

            // 프로젝트명과 키 전달
            approvalWindow.webContents.once("did-finish-load", () => {
                approvalWindow.webContents.send("approval:data", { projectName, key, channel: channelName });
            });

            // 창 로드 에러 처리
            approvalWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
                doResolve({ approved: false, reason: `Failed to load dialog: ${errorDescription}` });
            });
        } catch (error) {
            doResolve({ approved: false, reason: `Error: ${error.message}` });
        }
    });
}

// 앱 이벤트 핸들러
app.whenReady().then(async () => {
    initializeApp();
    createWindow();
    setupIpcHandlers();

    // HTTP 서버 시작
    try {
        await httpServer.start();
    } catch (error) {
        console.error("HTTP 서버 시작 실패:", error);
    }

    app.on("activate", () => {
        // macOS Dock 클릭 시 창 다시 표시
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else if (mainWindow && mainWindow.isDestroyed() === false) {
            // macOS에서 Dock 아이콘 다시 보이기
            if (process.platform === "darwin") {
                app.dock.show();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });
});

// 앱 종료 시 정리
app.on("before-quit", async () => {
    isQuitting = true;

    // 트레이 제거
    if (tray) {
        tray.destroy();
        tray = null;
    }

    // Vault 상태 확인 및 데이터 저장
    if (vault && !vault.isLocked) {
        try {
            // 동기 저장으로 Vault 잠금 (앱 종료시 비동기가 완료되기 전에 프로세스 종료되는 것 방지)
            await vault.lock(true);
        } catch (error) {
            console.error("Vault 저장/잠금 실패:", error);
        }
    }

    isUnlocked = false;

    // HTTP 서버 중지
    if (httpServer) {
        try {
            await httpServer.stop();
        } catch (error) {
            console.error("HTTP 서버 중지 실패:", error);
        }
    }

    logger.logApp("LocalKeys app shutdown");
});

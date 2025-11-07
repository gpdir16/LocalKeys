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
    logger = new Logger(path.join(LOCALKEYS_DIR, "access.log"));

    // Vault 초기화
    vault = new Vault(LOCALKEYS_DIR);

    // HTTP 서버 초기화
    httpServer = new HttpServer(vault, logger);

    // 승인 콜백 설정
    httpServer.setApprovalCallback(showApprovalDialog);

    // 트레이 아이콘 생성
    createTray();
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

        logger.log("Vault auto-locked");
    }
}

// 윈도우 생성
function createWindow() {
    // 헤드리스 모드 확인
    const isHeadless = process.argv.includes("--headless");

    if (isHeadless) {
        console.log("LocalKeys running in headless mode - GUI disabled");
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
        titleBarStyle: "hiddenInset",
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
        logger.log("Vault 이미 잠금 해제 상태 - 대시보드 표시");
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

            logger.log("창을 닫고 백그라운드 모드로 전환");
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
            logger.log(`Secret accessed: ${projectName}/${key}`);
            return { success: true, data: value };
        } else {
            logger.log(`Secret access denied: ${projectName}/${key}`);
            return { success: false, error: "Access denied" };
        }
    });

    // 로그 가져오기
    ipcMain.handle("logs:get", () => {
        if (!isUnlocked) return { success: false, error: "Vault is locked" };
        return { success: true, data: logger.getLogs() };
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
            logger.log(`Secrets exported: ${projectName} -> ${result.filePath}`);
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
}

// 승인 다이얼로그 표시
function showApprovalDialog(projectName, key) {
    return new Promise((resolve) => {
        console.log("=== showApprovalDialog 시작 ===", { projectName, key });

        // 헤드리스 모드 확인
        const isHeadless = process.argv.includes("--headless");

        if (isHeadless || !mainWindow) {
            console.log("헤드리스 모드 또는 메인 창 없음 - 자동 거부");
            // 헤드리스 모드나 메인 창이 없으면 콘솔 로그만 남기고 거부
            logger.log(`Secret access request in headless mode: ${projectName}/${key} - Auto denied`);
            resolve({ approved: false, reason: "Running in headless mode - no user interaction available" });
            return;
        }

        let approvalWindow = null;
        let timeout = null;
        let isResolved = false;

        const cleanup = () => {
            console.log("cleanup 호출됨");
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
            console.log("doResolve 호출됨:", result);
            if (isResolved) return; // 이미 처리됨
            isResolved = true;
            cleanup();
            resolve(result);
        };

        try {
            approvalWindow = new BrowserWindow({
                width: 450,
                height: 220,
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
            logger.log(`Secret access approval requested: ${projectName}/${key}`);

            approvalWindow.loadFile("src/views/approval.html");

            // 타임아웃 설정 (30초)
            timeout = setTimeout(() => {
                logger.log(`Secret access timeout: ${projectName}/${key} - Auto denied after 30 seconds`);
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
                    logger.log(`Secret access approved: ${projectName}/${key}`);
                    doResolve({ approved: true });
                } else {
                    logger.log(`Secret access denied by user: ${projectName}/${key}`);
                    doResolve({ approved: false, reason: "User denied" });
                }
            });

            // 창 닫기 이벤트 처리 (사용자가 X 버튼 클릭 시)
            approvalWindow.on("close", () => {
                if (!isResolved) {
                    logger.log(`Secret access dialog closed: ${projectName}/${key} - Auto denied`);
                    doResolve({ approved: false, reason: "Dialog closed" });
                }
            });

            // 프로젝트명과 키 전달
            approvalWindow.webContents.once("did-finish-load", () => {
                approvalWindow.webContents.send("approval:data", { projectName, key, channel: channelName });
            });

            // 창 로드 에러 처리
            approvalWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
                logger.log(`Approval dialog failed to load: ${errorDescription}`);
                doResolve({ approved: false, reason: `Failed to load dialog: ${errorDescription}` });
            });
        } catch (error) {
            logger.log(`Error creating approval dialog: ${error.message}`);
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

app.on("window-all-closed", () => {
    // 종료 중이 아니면 백그라운드 모드 유지
    if (!isQuitting) {
        logger.log("모든 창이 닫혔지만 백그라운드에서 계속 실행");
    }
});

// 앱 종료 시 정리
app.on("before-quit", async () => {
    isQuitting = true;
    logger.log("LocalKeys 앱 종료 시작");

    // 트레이 제거
    if (tray) {
        tray.destroy();
        tray = null;
    }

    // 실제 Vault 상태 확인 및 잠금
    if (vault && !vault.isLocked) {
        await vault.lock();
        logger.log("Vault 잠금 완료");
    }

    isUnlocked = false;

    // HTTP 서버 중지
    if (httpServer) {
        try {
            await httpServer.stop();
            logger.log("HTTP 서버 중지 완료");
        } catch (error) {
            console.error("HTTP 서버 중지 실패:", error);
        }
    }

    logger.log("LocalKeys 앱 종료 완료");
});

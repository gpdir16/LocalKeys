const { contextBridge, ipcRenderer } = require("electron");

// API 객체 정의
const api = {
    // Vault 관리
    vault: {
        setup: (password) => ipcRenderer.invoke("vault:setup", password),
        unlock: (password) => ipcRenderer.invoke("vault:unlock", password),
        lock: () => ipcRenderer.invoke("vault:lock"),
        save: () => ipcRenderer.invoke("vault:save"),
        exists: () => ipcRenderer.invoke("vault:exists"),
    },

    // 프로젝트 관리
    projects: {
        get: () => ipcRenderer.invoke("projects:get"),
        create: (name) => ipcRenderer.invoke("project:create", name),
        delete: (name) => ipcRenderer.invoke("project:delete", name),
    },

    // 시크릿 관리
    secrets: {
        get: (projectName, key) => ipcRenderer.invoke("secret:get", projectName, key),
        getAll: (projectName) => ipcRenderer.invoke("secrets:get", projectName),
        set: (projectName, key, value) => ipcRenderer.invoke("secret:set", projectName, key, value),
        delete: (projectName, key) => ipcRenderer.invoke("secret:delete", projectName, key),
        export: (projectName) => ipcRenderer.invoke("secrets:export", projectName),
    },

    // 로그 관리
    logs: {
        get: () => ipcRenderer.invoke("logs:get"),
        clear: () => ipcRenderer.invoke("logs:clear"),
    },

    // 화면 전환
    navigate: (page) => ipcRenderer.invoke("navigate", page),

    // 앱 관리
    app: {
        quit: () => ipcRenderer.invoke("app:quit"),
    },

    // CLI 관리
    cli: {
        install: () => ipcRenderer.invoke("cli:install"),
        uninstall: () => ipcRenderer.invoke("cli:uninstall"),
        check: () => ipcRenderer.invoke("cli:check"),
    },

    // 승인 다이얼로그
    approval: {
        onResponse: (callback) => ipcRenderer.on("approval:response", callback),
        sendData: (data) => ipcRenderer.send("approval:data", data),
    },

    // 다국어 지원
    i18n: {
        getTranslations: () => ipcRenderer.invoke("i18n:getTranslations"),
    },
};

// 렌더러 프로세스에 API 노출
contextBridge.exposeInMainWorld("localkeys", api);

// 개발 모드 확인
contextBridge.exposeInMainWorld("isDev", process.argv.includes("--dev"));

// 승인 다이얼로그를 위한 추가 API도 contextBridge로 노출
contextBridge.exposeInMainWorld("electronAPI", {
    // 승인 응답 전송
    sendApprovalResponse: (approved, channel) => {
        if (channel) {
            ipcRenderer.send(channel, approved);
        }
    },

    // 승인 데이터 수신
    onApprovalData: (callback) => {
        ipcRenderer.on("approval:data", (event, data) => {
            callback(data);
        });
    },
});

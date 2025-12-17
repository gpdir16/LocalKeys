const fs = require("fs");
const path = require("path");
const CryptoUtil = require("./crypto");

class Vault {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.vaultPath = path.join(dataDir, "vault.enc");
        this.saltPath = path.join(dataDir, "salt.txt");

        this.isLocked = true;
        this.data = null;
        this.key = null;
        this.saveTimeout = null;
        this.maxHistoryVersions = 50; // 각 시크릿당 최대 히스토리 버전 수
    }

    exists() {
        return fs.existsSync(this.vaultPath) && fs.existsSync(this.saltPath);
    }

    async setup(password) {
        if (this.exists()) {
            throw new Error("Vault already exists");
        }

        const salt = CryptoUtil.generateSalt();
        fs.writeFileSync(this.saltPath, salt.toString("hex"));

        try {
            fs.chmodSync(this.saltPath, 0o600);
        } catch (error) {
            console.error("Failed to set salt file permissions:", error.message);
        }

        this.key = CryptoUtil.deriveKey(password, salt);

        this.data = {
            version: "1.0.0",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            projects: Object.create(null),
        };

        await this._save();
        this.isLocked = false;
    }

    async unlock(password) {
        if (!this.exists()) {
            throw new Error("Vault does not exist");
        }

        try {
            const stats = fs.statSync(this.saltPath);
            const mode = stats.mode & 0o777;
            if (mode !== 0o600) {
                fs.chmodSync(this.saltPath, 0o600);
            }
        } catch (error) {}

        try {
            const stats = fs.statSync(this.vaultPath);
            const mode = stats.mode & 0o777;
            if (mode !== 0o600) {
                fs.chmodSync(this.vaultPath, 0o600);
            }
        } catch (error) {}

        const saltHex = fs.readFileSync(this.saltPath, "utf8");
        const salt = Buffer.from(saltHex, "hex");

        this.key = CryptoUtil.deriveKey(password, salt);

        try {
            const encryptedData = fs.readFileSync(this.vaultPath);
            this.data = CryptoUtil.decryptJson(encryptedData, this.key);
            this._normalizeData();
            this.isLocked = false;
        } catch (error) {
            this.key = null;
            this.data = null;
            throw new Error("Invalid password");
        }
    }

    async lock(sync = false) {
        if (!this.isLocked) {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }

            if (sync) {
                this._saveSync();
            } else {
                await this._save();
            }

            this.data = null;
            this.key = null;
            this.isLocked = true;
        }
    }

    getProjects() {
        this._ensureUnlocked();
        return Object.keys(this.data.projects).map((name) => ({
            name,
            secretCount: Object.keys(this.data.projects[name].secrets || {}).length,
            createdAt: this.data.projects[name].createdAt,
            updatedAt: this.data.projects[name].updatedAt,
        }));
    }

    createProject(name) {
        this._ensureUnlocked();

        if (this.data.projects[name]) {
            throw new Error(`Project '${name}' already exists`);
        }

        this.data.projects[name] = {
            name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            secrets: Object.create(null),
        };

        this.data.updatedAt = new Date().toISOString();
        this._scheduleAutoSave();
    }

    deleteProject(name) {
        this._ensureUnlocked();

        if (!this.data.projects[name]) {
            throw new Error(`Project '${name}' does not exist`);
        }

        delete this.data.projects[name];
        this.data.updatedAt = new Date().toISOString();
        this._scheduleAutoSave();
    }

    getSecrets(projectName) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const secrets = this.data.projects[projectName].secrets;
        const result = {};
        for (const [key, secret] of Object.entries(secrets)) {
            if (typeof secret === "string") {
                // 기존 형태 (하위 호환성)
                result[key] = { value: secret, expiresAt: null };
            } else {
                result[key] = {
                    value: secret.value,
                    expiresAt: secret.expiresAt ?? null,
                    createdAt: secret.createdAt ?? null,
                    updatedAt: secret.updatedAt ?? null,
                };
            }
        }
        return result;
    }

    getSecret(projectName, key) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const secret = this.data.projects[projectName].secrets[key];
        if (secret === undefined) {
            throw new Error(`Secret '${key}' does not exist in project '${projectName}'`);
        }

        // 기존 문자열 형태의 시크릿도 새 구조로 반환
        if (typeof secret === "string") {
            return { value: secret, expiresAt: null };
        }
        return {
            value: secret.value,
            expiresAt: secret.expiresAt ?? null,
            createdAt: secret.createdAt ?? null,
            updatedAt: secret.updatedAt ?? null,
        };
    }

    setSecret(projectName, key, value, expiresAt = null) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const now = new Date().toISOString();
        const existingSecret = this.data.projects[projectName].secrets[key];

        if (existingSecret === undefined) {
            // 새로운 시크릿 생성
            this.data.projects[projectName].secrets[key] = {
                value: value,
                expiresAt: expiresAt,
                createdAt: now,
                updatedAt: now,
                history: [], // 빈 히스토리로 시작
            };
        } else {
            // 기존 시크릿 업데이트
            const oldValue = typeof existingSecret === "string" ? existingSecret : existingSecret.value;
            const oldExpiresAt = typeof existingSecret === "object" ? existingSecret.expiresAt : null;
            const oldCreatedAt = typeof existingSecret === "object" ? existingSecret.createdAt : null;
            const oldHistory = typeof existingSecret === "object" && Array.isArray(existingSecret.history) ? existingSecret.history : [];

            // 값이 실제로 변경된 경우에만 히스토리에 추가
            if (oldValue !== value || oldExpiresAt !== expiresAt) {
                // 이전 값을 히스토리에 추가
                const historyEntry = {
                    value: oldValue,
                    expiresAt: oldExpiresAt,
                    changedAt: existingSecret.updatedAt || now,
                };

                const newHistory = [historyEntry, ...oldHistory];

                // 최대 히스토리 개수 제한
                if (newHistory.length > this.maxHistoryVersions) {
                    newHistory.splice(this.maxHistoryVersions);
                }

                // 시크릿 업데이트
                this.data.projects[projectName].secrets[key] = {
                    value: value,
                    expiresAt: expiresAt,
                    createdAt: oldCreatedAt || now,
                    updatedAt: now,
                    history: newHistory,
                };
            }
        }

        this.data.projects[projectName].updatedAt = now;
        this.data.updatedAt = now;
        this._scheduleAutoSave();
    }

    setSecrets(projectName, secrets) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const project = this.data.projects[projectName];
        for (const [key, value] of Object.entries(secrets)) {
            // import 시에는 만료일 없이 가져옴
            const existing = project.secrets[key];

            // 기존 시크릿과 값이 다르면 업데이트
            const existingValue = typeof existing === "string" ? existing : existing?.value;
            const existingExpiresAt = typeof existing === "object" ? (existing?.expiresAt ?? null) : null;
            if (existingValue !== value || existingExpiresAt !== null) {
                this.setSecret(projectName, key, value, null);
            }
        }
    }

    deleteSecret(projectName, key) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        if (this.data.projects[projectName].secrets[key] === undefined) {
            throw new Error(`Secret '${key}' does not exist in project '${projectName}'`);
        }

        delete this.data.projects[projectName].secrets[key];
        this.data.projects[projectName].updatedAt = new Date().toISOString();
        this.data.updatedAt = new Date().toISOString();
        this._scheduleAutoSave();
    }

    // 시크릿 히스토리 조회
    getSecretHistory(projectName, key) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const secret = this.data.projects[projectName].secrets[key];
        if (secret === undefined) {
            throw new Error(`Secret '${key}' does not exist in project '${projectName}'`);
        }

        // 현재 버전 + 히스토리 반환
        const currentVersion = {
            value: typeof secret === "string" ? secret : secret.value,
            expiresAt: typeof secret === "object" ? secret.expiresAt : null,
            changedAt: typeof secret === "object" ? secret.updatedAt : null,
            isCurrent: true,
        };

        const history = typeof secret === "object" && Array.isArray(secret.history) ? secret.history : [];

        return {
            current: currentVersion,
            history: history.map((entry) => ({
                ...entry,
                isCurrent: false,
            })),
            totalVersions: history.length + 1,
        };
    }

    // 이전 버전으로 복원
    restoreSecretVersion(projectName, key, versionIndex) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const secret = this.data.projects[projectName].secrets[key];
        if (secret === undefined) {
            throw new Error(`Secret '${key}' does not exist in project '${projectName}'`);
        }

        const history = typeof secret === "object" && Array.isArray(secret.history) ? secret.history : [];

        if (versionIndex < 0 || versionIndex >= history.length) {
            throw new Error(`Invalid version index: ${versionIndex}`);
        }

        const versionToRestore = history[versionIndex];

        // 현재 값을 히스토리에 저장하고, 선택한 버전을 현재 값으로 설정
        this.setSecret(projectName, key, versionToRestore.value, versionToRestore.expiresAt);
    }

    _ensureUnlocked() {
        if (this.isLocked) {
            throw new Error("Vault is locked");
        }
    }

    _normalizeData() {
        if (!this.data || typeof this.data !== "object") {
            throw new Error("Invalid vault data");
        }

        const projects = this.data.projects;
        const normalizedProjects = Object.create(null);

        if (projects && typeof projects === "object") {
            for (const [name, project] of Object.entries(projects)) {
                if (!project || typeof project !== "object") continue;

                const normalizedProject = { ...project };
                const secrets = project.secrets;
                const normalizedSecrets = Object.create(null);

                if (secrets && typeof secrets === "object") {
                    for (const [key, secret] of Object.entries(secrets)) {
                        normalizedSecrets[key] = secret;
                    }
                }

                normalizedProject.secrets = normalizedSecrets;
                normalizedProjects[name] = normalizedProject;
            }
        }

        this.data.projects = normalizedProjects;
    }

    async _save() {
        if (!this.data || !this.key) {
            return;
        }

        const encryptedData = CryptoUtil.encryptJson(this.data, this.key);

        return new Promise((resolve, reject) => {
            fs.writeFile(this.vaultPath, encryptedData, (err) => {
                if (err) {
                    reject(err);
                } else {
                    try {
                        fs.chmodSync(this.vaultPath, 0o600);
                    } catch (error) {}
                    resolve();
                }
            });
        });
    }

    _saveSync() {
        if (!this.data || !this.key) {
            return;
        }

        const encryptedData = CryptoUtil.encryptJson(this.data, this.key);
        fs.writeFileSync(this.vaultPath, encryptedData);

        try {
            fs.chmodSync(this.vaultPath, 0o600);
        } catch (error) {}
    }

    _scheduleAutoSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(async () => {
            try {
                await this._save();
            } catch (error) {
                console.error("자동 저장 실패:", error);
            }
        }, 1000);
    }

    async saveNow() {
        if (this.isLocked) {
            throw new Error("Vault is locked");
        }

        // 기존 타이머 취소
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        return this._save();
    }
}

module.exports = Vault;

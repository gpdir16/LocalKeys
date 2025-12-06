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
            projects: {},
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
            secrets: {},
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

        return { ...this.data.projects[projectName].secrets };
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

        return secret;
    }

    setSecret(projectName, key, value) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        this.data.projects[projectName].secrets[key] = value;
        this.data.projects[projectName].updatedAt = new Date().toISOString();
        this.data.updatedAt = new Date().toISOString();
        this._scheduleAutoSave();
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

    _ensureUnlocked() {
        if (this.isLocked) {
            throw new Error("Vault is locked");
        }
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

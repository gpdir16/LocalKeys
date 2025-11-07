const fs = require("fs");
const path = require("path");
const CryptoUtil = require("./crypto");

/**
 * Vault 관리 클래스
 * 프로젝트와 시크릿을 암호화된 형태로 저장하고 관리
 */
class Vault {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.vaultPath = path.join(dataDir, "vault.enc");
        this.saltPath = path.join(dataDir, "salt.txt");
        this.configPath = path.join(dataDir, "config.json");

        this.isLocked = true;
        this.data = null; // 메모리에만 저장되는 복호화된 데이터
        this.key = null; // 메모리에만 저장되는 암호화 키
    }

    /**
     * Vault가 존재하는지 확인
     * @returns {boolean} Vault 존재 여부
     */
    exists() {
        return fs.existsSync(this.vaultPath) && fs.existsSync(this.saltPath);
    }

    /**
     * 최초 Vault 설정
     * @param {string} password - 마스터 비밀번호
     */
    async setup(password) {
        if (this.exists()) {
            throw new Error("Vault already exists");
        }

        // 솔트 생성 및 저장
        const salt = CryptoUtil.generateSalt();
        fs.writeFileSync(this.saltPath, salt.toString("hex"));

        // 키 파생
        this.key = CryptoUtil.deriveKey(password, salt);

        // 초기 데이터 구조
        this.data = {
            version: "1.0.0",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            projects: {},
        };

        // 암호화하여 저장
        await this._save();
        this.isLocked = false;

        // 기본 설정 파일 생성
        this._createDefaultConfig();
    }

    /**
     * Vault 잠금 해제
     * @param {string} password - 마스터 비밀번호
     */
    async unlock(password) {
        if (!this.exists()) {
            throw new Error("Vault does not exist");
        }

        // 솔트 로드
        const saltHex = fs.readFileSync(this.saltPath, "utf8");
        const salt = Buffer.from(saltHex, "hex");

        // 키 파생
        this.key = CryptoUtil.deriveKey(password, salt);

        try {
            // 암호화된 데이터 로드 및 복호화
            const encryptedData = fs.readFileSync(this.vaultPath);
            this.data = CryptoUtil.decryptJson(encryptedData, this.key);
            this.isLocked = false;
        } catch (error) {
            this.key = null;
            this.data = null;
            throw new Error("Invalid password");
        }
    }

    /**
     * Vault 잠금
     */
    async lock() {
        if (!this.isLocked) {
            await this._save(); // 변경사항 저장
            this.data = null;
            this.key = null;
            this.isLocked = true;
        }
    }

    /**
     * 프로젝트 목록 가져오기
     * @returns {Array} 프로젝트 목록
     */
    getProjects() {
        this._ensureUnlocked();
        return Object.keys(this.data.projects).map((name) => ({
            name,
            secretCount: Object.keys(this.data.projects[name].secrets || {}).length,
            createdAt: this.data.projects[name].createdAt,
            updatedAt: this.data.projects[name].updatedAt,
        }));
    }

    /**
     * 프로젝트 생성
     * @param {string} name - 프로젝트 이름
     */
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
    }

    /**
     * 프로젝트 삭제
     * @param {string} name - 프로젝트 이름
     */
    deleteProject(name) {
        this._ensureUnlocked();

        if (!this.data.projects[name]) {
            throw new Error(`Project '${name}' does not exist`);
        }

        delete this.data.projects[name];
        this.data.updatedAt = new Date().toISOString();
    }

    /**
     * 시크릿 목록 가져오기
     * @param {string} projectName - 프로젝트 이름
     * @returns {Object} 시크릿 객체
     */
    getSecrets(projectName) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        return { ...this.data.projects[projectName].secrets };
    }

    /**
     * 시크릿 가져오기
     * @param {string} projectName - 프로젝트 이름
     * @param {string} key - 시크릿 키
     * @returns {string} 시크릿 값
     */
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

    /**
     * 시크릿 설정
     * @param {string} projectName - 프로젝트 이름
     * @param {string} key - 시크릿 키
     * @param {string} value - 시크릿 값
     */
    setSecret(projectName, key, value) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        this.data.projects[projectName].secrets[key] = value;
        this.data.projects[projectName].updatedAt = new Date().toISOString();
        this.data.updatedAt = new Date().toISOString();
    }

    /**
     * 시크릿 삭제
     * @param {string} projectName - 프로젝트 이름
     * @param {string} key - 시크릿 키
     */
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
    }

    /**
     * Vault가 잠금 해제 상태인지 확인
     * @private
     */
    _ensureUnlocked() {
        if (this.isLocked) {
            throw new Error("Vault is locked");
        }
    }

    /**
     * 데이터를 암호화하여 파일에 저장
     * @private
     */
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
                    resolve();
                }
            });
        });
    }

    /**
     * 기본 설정 파일 생성
     * @private
     */
    _createDefaultConfig() {
        const config = {
            version: "1.0.0",
            autoLockMinutes: 5,
            theme: "dark",
            language: "ko",
        };

        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    }
}

module.exports = Vault;

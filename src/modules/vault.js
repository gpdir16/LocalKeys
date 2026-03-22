const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const CryptoUtil = require("./crypto");
const { isSilentResolvable, mergeVaultThreeWay, snapshotSecretForBaseline, normalizeFavoritesForCompare } = require("./vault-merge");

const VAULT_EXTERNAL_CHANGE = "VAULT_EXTERNAL_CHANGE";

function sha256Hex(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

class Vault {
    constructor(dataDir, options = {}) {
        this.dataDir = dataDir;
        this.vaultPath = path.join(dataDir, "vault.enc");
        this.saltPath = path.join(dataDir, "salt.txt");

        this.isLocked = true;
        this.data = null;
        this.key = null;
        this.saveTimeout = null;
        this.maxHistoryVersions = 50; // 각 시크릿당 최대 히스토리 버전 수

        this._vaultId = options.vaultId ?? null;
        this._onConflictNotify = typeof options.onConflict === "function" ? options.onConflict : null;
        // vault.enc 암호문 전체의 SHA-256 (낙관적 동시성)
        this._diskContentHash = null;
        // 마지막으로 디스크와 맞췄을 때 시크릿 값 스냅샷(3-way 병합 공통 조상)
        this._syncBaseline = null;
        this._periodicSyncInProgress = false;
        // 주기 병합 충돌 알림 스팸 방지 (ms 타임스탬프)
        this._periodicConflictNotifyCooldownUntil = 0;
    }

    _refreshSyncBaseline() {
        this._syncBaseline = { projects: Object.create(null) };
        const projects = this.data?.projects || {};
        for (const [name, proj] of Object.entries(projects)) {
            const sec = proj?.secrets && typeof proj.secrets === "object" ? proj.secrets : {};
            const snap = Object.create(null);
            for (const [k, v] of Object.entries(sec)) {
                snap[k] = snapshotSecretForBaseline(v);
            }
            this._syncBaseline.projects[name] = { secrets: snap };
        }
        this._syncBaseline.favorites = normalizeFavoritesForCompare(this.data.favorites);
    }

    // 디스크가 바뀌었으면 3-way 병합(비충돌 시 디스크 변경 수용) 후 강제 저장. 동시 편집 충돌 시 알림만 하고 메모리는 유지.
    async tickPeriodicDiskSync() {
        if (this.isLocked || this._diskContentHash == null) {
            return { didSync: false };
        }
        if (!this.isDiskStale()) {
            return { didSync: false };
        }
        if (this._periodicSyncInProgress) {
            return { didSync: false };
        }
        this._periodicSyncInProgress = true;
        try {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            const remote = this.peekRemoteData();
            const local = JSON.parse(JSON.stringify(this.data));
            const baseline = this._syncBaseline || { projects: {} };
            const result = mergeVaultThreeWay(local, remote, baseline);
            if (result.conflicts.length > 0) {
                const now = Date.now();
                if (!this._periodicConflictNotifyCooldownUntil || now >= this._periodicConflictNotifyCooldownUntil) {
                    this._periodicConflictNotifyCooldownUntil = now + 30000;
                    this._notifyConflict({ reason: "periodic_merge_conflict", conflicts: result.conflicts });
                }
                return { didSync: false, conflict: true };
            }
            this.applyMergedData(result.merged);
            await this.saveNow({ force: true });
            return { didSync: true };
        } catch (error) {
            return { didSync: false, error: error.message || String(error) };
        } finally {
            this._periodicSyncInProgress = false;
        }
    }

    setVaultId(vaultId) {
        this._vaultId = vaultId;
    }

    getVaultId() {
        return this._vaultId;
    }

    setConflictNotifier(fn) {
        this._onConflictNotify = typeof fn === "function" ? fn : null;
    }

    _notifyConflict(payload) {
        try {
            this._onConflictNotify?.({
                ...payload,
                vaultId: this._vaultId,
            });
        } catch (error) {
            console.error("Vault conflict notifier failed:", error?.message || error);
        }
    }

    _setDiskHashFromCiphertext(encryptedBuffer) {
        this._diskContentHash = sha256Hex(encryptedBuffer);
    }

    _verifyDiskUnchangedBeforeSave(force) {
        if (force) {
            return;
        }
        if (this._diskContentHash == null) {
            return;
        }
        if (!fs.existsSync(this.vaultPath)) {
            const err = new Error("Vault file was removed or replaced externally");
            err.code = VAULT_EXTERNAL_CHANGE;
            throw err;
        }
        let current;
        try {
            current = fs.readFileSync(this.vaultPath);
        } catch (error) {
            const err = new Error("Could not read vault file");
            err.code = VAULT_EXTERNAL_CHANGE;
            throw err;
        }
        if (sha256Hex(current) !== this._diskContentHash) {
            const err = new Error("Vault file was changed externally");
            err.code = VAULT_EXTERNAL_CHANGE;
            throw err;
        }
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
            favorites: {
                projects: [],
                secrets: Object.create(null),
            },
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

        const saltHex = fs.readFileSync(this.saltPath, "utf8");
        const salt = Buffer.from(saltHex, "hex");
        const key = CryptoUtil.deriveKey(password, salt);

        this._loadVaultData(key, "Invalid password");
    }

    async unlockWithKey(key) {
        if (!this.exists()) {
            throw new Error("Vault does not exist");
        }
        this._loadVaultData(key, "Invalid key");
    }

    _loadVaultData(key, errorMessage) {
        try {
            const stats = fs.statSync(this.vaultPath);
            const mode = stats.mode & 0o777;
            if (mode !== 0o600) {
                fs.chmodSync(this.vaultPath, 0o600);
            }
        } catch (error) {}

        this.key = key;

        try {
            const encryptedData = fs.readFileSync(this.vaultPath);
            this._setDiskHashFromCiphertext(encryptedData);
            this.data = CryptoUtil.decryptJson(encryptedData, this.key);
            this._normalizeData();
            this.isLocked = false;
            this._refreshSyncBaseline();
        } catch (error) {
            this.key = null;
            this.data = null;
            this._diskContentHash = null;
            this._syncBaseline = null;
            throw new Error(errorMessage);
        }
    }

    async lock(sync = false) {
        if (!this.isLocked) {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }

            try {
                if (sync) {
                    this._saveSync(false);
                } else {
                    await this._save(false);
                }
            } catch (error) {
                if (error.code === VAULT_EXTERNAL_CHANGE) {
                    console.error("Vault lock: 저장 생략(외부에서 vault.enc 변경됨) — 메모리에만 있던 변경은 반영되지 않습니다.");
                } else {
                    throw error;
                }
            }

            this.data = null;
            this.key = null;
            this._diskContentHash = null;
            this._syncBaseline = null;
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

        // 즐겨찾기에서도 제거
        if (this.data.favorites) {
            if (Array.isArray(this.data.favorites.projects)) {
                this.data.favorites.projects = this.data.favorites.projects.filter((p) => p !== name);
            }
            if (this.data.favorites.secrets && typeof this.data.favorites.secrets === "object") {
                delete this.data.favorites.secrets[name];
            }
        }

        this.data.updatedAt = new Date().toISOString();
        this._scheduleAutoSave();
    }

    getSecrets(projectName) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const secrets = this.data.projects[projectName].secrets;
        const result = Object.create(null);
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

    renameSecret(projectName, fromKey, toKey) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        if (typeof fromKey !== "string" || typeof toKey !== "string") {
            throw new Error("Invalid secret key");
        }

        if (!fromKey.trim() || !toKey.trim()) {
            throw new Error("Secret key cannot be empty");
        }

        if (fromKey === toKey) {
            return;
        }

        const project = this.data.projects[projectName];
        const secrets = project.secrets;

        if (secrets[fromKey] === undefined) {
            throw new Error(`Secret '${fromKey}' does not exist in project '${projectName}'`);
        }

        if (secrets[toKey] !== undefined) {
            throw new Error(`Secret '${toKey}' already exists in project '${projectName}'`);
        }

        secrets[toKey] = secrets[fromKey];
        delete secrets[fromKey];

        // 즐겨찾기에서도 키 변경
        const favoriteKeys = this.data.favorites?.secrets?.[projectName];
        if (Array.isArray(favoriteKeys)) {
            const nextKeys = [];
            const seen = new Set();
            for (const k of favoriteKeys) {
                const next = k === fromKey ? toKey : k;
                if (typeof next !== "string") continue;
                if (seen.has(next)) continue;
                seen.add(next);
                nextKeys.push(next);
            }

            if (nextKeys.length > 0) {
                this.data.favorites.secrets[projectName] = nextKeys;
            } else {
                delete this.data.favorites.secrets[projectName];
            }
        }

        const now = new Date().toISOString();
        project.updatedAt = now;
        this.data.updatedAt = now;
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

        // 즐겨찾기에서도 제거
        const favoriteKeys = this.data.favorites?.secrets?.[projectName];
        if (Array.isArray(favoriteKeys)) {
            const nextKeys = favoriteKeys.filter((k) => k !== key);
            if (nextKeys.length > 0) {
                this.data.favorites.secrets[projectName] = nextKeys;
            } else {
                delete this.data.favorites.secrets[projectName];
            }
        }

        const now = new Date().toISOString();
        this.data.projects[projectName].updatedAt = now;
        this.data.updatedAt = now;
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

        // favorites 정규화 (프로토타입 오염 방지 + 데이터 정리)
        const favorites = this.data.favorites;
        const normalizedFavorites = {
            projects: [],
            secrets: Object.create(null),
        };

        if (favorites && typeof favorites === "object") {
            // 프로젝트 즐겨찾기
            if (Array.isArray(favorites.projects)) {
                const seen = new Set();
                for (const projectName of favorites.projects) {
                    if (typeof projectName !== "string") continue;
                    if (!normalizedProjects[projectName]) continue;
                    if (seen.has(projectName)) continue;
                    seen.add(projectName);
                    normalizedFavorites.projects.push(projectName);
                }
            }

            // 시크릿 즐겨찾기
            const favoriteSecrets = favorites.secrets;
            if (favoriteSecrets && typeof favoriteSecrets === "object") {
                for (const [projectName, secretKeys] of Object.entries(favoriteSecrets)) {
                    if (!normalizedProjects[projectName]) continue;
                    if (!Array.isArray(secretKeys)) continue;

                    const projectSecrets = normalizedProjects[projectName].secrets || Object.create(null);
                    const seenKeys = new Set();
                    const normalizedKeys = [];
                    for (const key of secretKeys) {
                        if (typeof key !== "string") continue;
                        if (projectSecrets[key] === undefined) continue;
                        if (seenKeys.has(key)) continue;
                        seenKeys.add(key);
                        normalizedKeys.push(key);
                    }

                    if (normalizedKeys.length > 0) {
                        normalizedFavorites.secrets[projectName] = normalizedKeys;
                    }
                }
            }
        }

        this.data.favorites = normalizedFavorites;
    }

    async _save(force = false) {
        if (!this.data || !this.key) {
            return;
        }

        const encryptedData = CryptoUtil.encryptJson(this.data, this.key);
        this._verifyDiskUnchangedBeforeSave(force);

        return new Promise((resolve, reject) => {
            fs.writeFile(this.vaultPath, encryptedData, (err) => {
                if (err) {
                    reject(err);
                } else {
                    try {
                        fs.chmodSync(this.vaultPath, 0o600);
                    } catch (error) {}
                    this._setDiskHashFromCiphertext(encryptedData);
                    this._refreshSyncBaseline();
                    resolve();
                }
            });
        });
    }

    _saveSync(force = false) {
        if (!this.data || !this.key) {
            return;
        }

        const encryptedData = CryptoUtil.encryptJson(this.data, this.key);
        this._verifyDiskUnchangedBeforeSave(force);
        fs.writeFileSync(this.vaultPath, encryptedData);

        try {
            fs.chmodSync(this.vaultPath, 0o600);
        } catch (error) {}
        this._setDiskHashFromCiphertext(encryptedData);
        this._refreshSyncBaseline();
    }

    _scheduleAutoSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(async () => {
            try {
                await this._save(false);
            } catch (error) {
                if (error.code === VAULT_EXTERNAL_CHANGE) {
                    const silent = await this._trySilentResyncAfterConflict();
                    if (!silent) {
                        this._notifyConflict({ reason: "save_failed" });
                        console.error("자동 저장 실패:", error);
                    }
                } else {
                    console.error("자동 저장 실패:", error);
                }
            }
        }, 1000);
    }

    async _trySilentResyncAfterConflict() {
        try {
            const local = JSON.parse(JSON.stringify(this.data));
            const remote = this.peekRemoteData();
            if (!isSilentResolvable(local, remote)) {
                return false;
            }
            await this.reloadFromDisk();
            return true;
        } catch (error) {
            return false;
        }
    }

    async saveNow(options = {}) {
        if (this.isLocked) {
            throw new Error("Vault is locked");
        }

        const force = options.force === true;

        // 기존 타이머 취소
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        return this._save(force);
    }

    async reloadFromDisk() {
        this._ensureUnlocked();
        let encryptedData;
        try {
            encryptedData = fs.readFileSync(this.vaultPath);
        } catch (error) {
            throw new Error("Vault file was removed or replaced externally");
        }
        this._setDiskHashFromCiphertext(encryptedData);
        this.data = CryptoUtil.decryptJson(encryptedData, this.key);
        this._normalizeData();
        this._refreshSyncBaseline();
    }

    isDiskStale() {
        if (this.isLocked || this._diskContentHash == null) {
            return false;
        }
        if (!fs.existsSync(this.vaultPath)) {
            return true;
        }
        try {
            const current = fs.readFileSync(this.vaultPath);
            return sha256Hex(current) !== this._diskContentHash;
        } catch (error) {
            return true;
        }
    }

    // 병합 UI용: 임의 데이터를 현재 금고와 동일 규칙으로 정규화한 복사본
    getNormalizedCopyOfData(incoming) {
        this._ensureUnlocked();
        const prev = this.data;
        this.data = JSON.parse(JSON.stringify(incoming));
        try {
            this._normalizeData();
            return JSON.parse(JSON.stringify(this.data));
        } finally {
            this.data = prev;
        }
    }

    // 디스크의 vault.enc를 복호화한 뒤 정규화한 스냅샷 (메모리의 this.data는 그대로)
    peekRemoteData() {
        this._ensureUnlocked();
        const encryptedData = fs.readFileSync(this.vaultPath);
        const raw = CryptoUtil.decryptJson(encryptedData, this.key);
        return this.getNormalizedCopyOfData(raw);
    }

    // 병합 결과를 메모리에 반영 (이후 saveNow({ force: true }) 필요할 수 있음)
    applyMergedData(mergedPlain) {
        this._ensureUnlocked();
        this.data = this.getNormalizedCopyOfData(mergedPlain);
    }

    // 즐겨찾기 관련 메서드
    toggleProjectFavorite(projectName) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        const current = Array.isArray(this.data.favorites.projects) ? this.data.favorites.projects : [];
        const isFavorite = current.includes(projectName);
        if (isFavorite) {
            this.data.favorites.projects = current.filter((p) => p !== projectName);
        } else {
            const next = current.filter((p) => p !== projectName);
            next.push(projectName);
            this.data.favorites.projects = next;
        }

        this.data.updatedAt = new Date().toISOString();
        this._scheduleAutoSave();

        return !isFavorite; // true면 추가됨, false면 제거됨
    }

    toggleSecretFavorite(projectName, secretKey) {
        this._ensureUnlocked();

        if (!this.data.projects[projectName]) {
            throw new Error(`Project '${projectName}' does not exist`);
        }

        if (this.data.projects[projectName].secrets[secretKey] === undefined) {
            throw new Error(`Secret '${secretKey}' does not exist in project '${projectName}'`);
        }

        const current = Array.isArray(this.data.favorites.secrets?.[projectName]) ? this.data.favorites.secrets[projectName] : [];
        const isFavorite = current.includes(secretKey);
        if (isFavorite) {
            const next = current.filter((k) => k !== secretKey);
            if (next.length > 0) {
                this.data.favorites.secrets[projectName] = next;
            } else {
                delete this.data.favorites.secrets[projectName];
            }
        } else {
            const next = current.filter((k) => k !== secretKey);
            next.push(secretKey);
            this.data.favorites.secrets[projectName] = next;
        }

        this.data.updatedAt = new Date().toISOString();
        this._scheduleAutoSave();

        return !isFavorite; // true면 추가됨, false면 제거됨
    }

    getFavorites() {
        this._ensureUnlocked();

        const secrets = Object.create(null);
        const favoriteSecrets = this.data.favorites?.secrets;
        if (favoriteSecrets && typeof favoriteSecrets === "object") {
            for (const [projectName, secretKeys] of Object.entries(favoriteSecrets)) {
                if (!Array.isArray(secretKeys)) continue;
                secrets[projectName] = secretKeys.filter((k) => typeof k === "string");
            }
        }

        return {
            projects: Array.isArray(this.data.favorites?.projects) ? [...this.data.favorites.projects] : [],
            secrets,
        };
    }

    // 통계 관련 메서드
    getStatistics() {
        this._ensureUnlocked();

        const totalProjects = Object.keys(this.data.projects).length;
        let totalSecrets = 0;
        let expiringSecrets = 0;
        let hasExpired = false;

        const now = new Date();
        const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        for (const project of Object.values(this.data.projects)) {
            const secrets = project.secrets || {};
            totalSecrets += Object.keys(secrets).length;

            for (const secret of Object.values(secrets)) {
                const expiresAt = typeof secret === "object" ? secret.expiresAt : null;
                if (expiresAt) {
                    const expiryDate = new Date(expiresAt);
                    // 만료된 것 + 7일 이내 만료 예정
                    if (expiryDate <= sevenDaysLater) {
                        expiringSecrets++;
                        // 이미 만료된 경우 플래그 설정
                        if (expiryDate < now) {
                            hasExpired = true;
                        }
                    }
                }
            }
        }

        return {
            totalProjects,
            totalSecrets,
            expiringSecrets,
            hasExpired,
        };
    }
}

Vault.VAULT_EXTERNAL_CHANGE = VAULT_EXTERNAL_CHANGE;

module.exports = Vault;

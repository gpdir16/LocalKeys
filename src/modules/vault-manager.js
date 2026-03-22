const fs = require("fs");
const path = require("path");
const Vault = require("./vault");
const CryptoUtil = require("./crypto");

// vaults.enc: 시스템 금고 키로 암호화된 외부 금고 목록 및 각 금고의 복호화 키 저장
const VAULTS_CONFIG_FILE = "vaults.enc";
const INVALID_NAME_CHARS = /[\/\\*?"<>|]/;
const SYSTEM_VAULT_ID = "system";
const SYSTEM_VAULT_NAME = "System";

class VaultManager {
    constructor(localkeysDir) {
        this.localkeysDir = localkeysDir;
        this.configPath = path.join(localkeysDir, VAULTS_CONFIG_FILE);

        this.systemVault = null; // 시스템 금고 인스턴스
        this.vaultsConfig = null; // 잠금 해제 후 복호화된 설정 ({ version, otherVaults })
        this.vaults = new Map(); // vaultId -> Vault instance
        this.activeVaultId = SYSTEM_VAULT_ID;
        /** @type {((payload: { vaultId: string | null; reason?: string }) => void) | null} */
        this._conflictNotifier = null;
    }

    init() {
        this._ensureSystemVaultInstance();
    }

    setConflictNotifier(fn) {
        this._conflictNotifier = typeof fn === "function" ? fn : null;
    }

    _wireVaultConflict(vault) {
        if (!vault) return;
        vault.setConflictNotifier((payload) => {
            if (this._conflictNotifier) {
                this._conflictNotifier({
                    ...payload,
                    vaultId: vault.getVaultId(),
                });
            }
        });
    }

    async reloadVaultFromDisk(vaultId) {
        const vault = this.vaults.get(vaultId);
        if (!vault || vault.isLocked) {
            throw new Error("Vault is not available");
        }
        await vault.reloadFromDisk();
    }

    // 시스템 금고 최초 설정 (비밀번호 최초 등록)
    async setupSystemVault(password) {
        this._ensureSystemVaultInstance();
        if (this.systemVault.exists()) {
            throw new Error("System vault already exists");
        }
        await this.systemVault.setup(password);
        this.vaultsConfig = this._defaultVaultsConfig();
        this.saveConfig();
    }

    // 시스템 금고 잠금 해제-> vaults.enc 복호화-> 외부 금고 자동 잠금 해제
    async unlockAll(password) {
        this._ensureSystemVaultInstance();
        await this.systemVault.unlock(password);

        // 시스템 금고를 vaults Map에 다시 등록 (lockAll 후 사라졌을 수 있음)
        this.vaults.set(SYSTEM_VAULT_ID, this.systemVault);

        this._loadVaultsConfig(this.systemVault.key);

        // 외부 금고 자동 잠금 해제 (저장된 키 사용) - 병렬 처리
        await Promise.all(
            this.vaultsConfig.otherVaults
                .filter((v) => v.encryptionKey)
                .map(async (vaultEntry) => {
                    try {
                        const vault = new Vault(vaultEntry.path);
                        if (!vault.exists()) return;
                        const keyBuffer = Buffer.from(vaultEntry.encryptionKey, "hex");
                        await vault.unlockWithKey(keyBuffer);
                        vault.setVaultId(vaultEntry.id);
                        this._wireVaultConflict(vault);
                        this.vaults.set(vaultEntry.id, vault);
                    } catch (err) {
                        console.error(`Failed to auto-unlock vault "${vaultEntry.name}":`, err.message);
                    }
                }),
        );
    }

    // 금고 목록 반환 (암호화 키는 절대 포함하지 않음)
    getVaultList() {
        const list = [
            {
                id: SYSTEM_VAULT_ID,
                name: SYSTEM_VAULT_NAME,
                path: this.localkeysDir,
                isSystem: true,
                isActive: this.activeVaultId === SYSTEM_VAULT_ID,
                status: this.getVaultStatus(SYSTEM_VAULT_ID),
            },
        ];

        if (this.vaultsConfig) {
            for (const v of this.vaultsConfig.otherVaults) {
                list.push({
                    id: v.id,
                    name: v.name,
                    path: v.path,
                    isSystem: false,
                    isActive: v.id === this.activeVaultId,
                    status: this.getVaultStatus(v.id),
                });
            }
        }

        return list;
    }

    // 현재 활성 금고 인스턴스 반환
    getActiveVault() {
        if (this.activeVaultId === SYSTEM_VAULT_ID) {
            return this.systemVault;
        }
        return this.vaults.get(this.activeVaultId) || this.systemVault || null;
    }

    getActiveVaultId() {
        return this.activeVaultId;
    }

    // 금고 전환 (오프라인 복귀 시 저장된 키로 자동 재잠금 해제)
    async switchVault(vaultId) {
        if (vaultId === SYSTEM_VAULT_ID) {
            this.activeVaultId = SYSTEM_VAULT_ID;
            return this.vaults.get(SYSTEM_VAULT_ID);
        }

        if (!this.vaultsConfig) throw new Error("Vault config not loaded");

        const vaultEntry = this.vaultsConfig.otherVaults.find((v) => v.id === vaultId);
        if (!vaultEntry) throw new Error(`Vault '${vaultId}' not found`);

        if (!this.checkVaultAvailability(vaultId)) {
            throw new Error(`Vault '${vaultEntry.name}' is offline`);
        }

        let vault = this.vaults.get(vaultId);
        if (!vault || vault.isLocked) {
            vault = await this._reactivateVault(vaultId);
        }
        if (!vault || vault.isLocked) {
            throw new Error(`Vault '${vaultEntry.name}' is not unlocked`);
        }

        this.activeVaultId = vaultId;
        return vault;
    }

    // 새 외부 금고 생성 (별도 비밀번호로 암호화, 키를 vaults.enc에 저장)
    async createVault(name, folderPath, vaultPassword) {
        this._validateVaultName(name);
        if (!this.vaultsConfig) throw new Error("Vault config not loaded");
        if (this.vaultsConfig.otherVaults.some((v) => v.name === name)) throw new Error(`Vault name '${name}' already exists`);

        const lkvPath = path.join(folderPath, "lkv");
        if (this.vaultsConfig.otherVaults.some((v) => v.path === lkvPath)) throw new Error("A vault already exists at this path");

        fs.mkdirSync(lkvPath, { recursive: true });
        const newVault = new Vault(lkvPath);
        await newVault.setup(vaultPassword);

        return this._registerVaultEntry(name, lkvPath, newVault);
    }

    // 기존 외부 금고 가져오기
    // - 새 컴퓨터: vaultPassword 필수 (외부 금고의 비밀번호로 잠금 해제 후 키를 vaults.enc에 저장)
    // - 이미 추가된 컴퓨터: vaults.enc에 키가 있어 자동 잠금 해제 (이 메서드는 새 추가에만 사용)
    async importVault(name, lkvPath, vaultPassword) {
        this._validateVaultName(name);
        if (!this.vaultsConfig) throw new Error("Vault config not loaded");
        if (this.vaultsConfig.otherVaults.some((v) => v.name === name)) throw new Error(`Vault name '${name}' already exists`);
        if (this.vaultsConfig.otherVaults.some((v) => v.path === lkvPath)) throw new Error("This vault path is already added");

        const testVault = new Vault(lkvPath);
        if (!testVault.exists()) throw new Error("No valid vault found at the specified path");

        // 비밀번호로 잠금 해제해 유효성 검증 및 키 획득
        await testVault.unlock(vaultPassword);

        return this._registerVaultEntry(name, lkvPath, testVault);
    }

    // 금고 이름 변경
    renameVault(vaultId, newName) {
        if (vaultId === SYSTEM_VAULT_ID) throw new Error("Cannot rename the System vault");
        if (!this.vaultsConfig) throw new Error("Vault config not loaded");

        const vaultEntry = this.vaultsConfig.otherVaults.find((v) => v.id === vaultId);
        if (!vaultEntry) throw new Error(`Vault '${vaultId}' not found`);

        this._validateVaultName(newName);

        if (this.vaultsConfig.otherVaults.some((v) => v.id !== vaultId && v.name === newName)) {
            throw new Error(`Vault name '${newName}' already exists`);
        }

        vaultEntry.name = newName;
        this.saveConfig();
    }

    // 금고 목록에서 제거 (파일 삭제 없음)
    removeVault(vaultId) {
        if (vaultId === SYSTEM_VAULT_ID) throw new Error("Cannot remove the System vault");
        if (!this.vaultsConfig) throw new Error("Vault config not loaded");

        const vaultEntry = this.vaultsConfig.otherVaults.find((v) => v.id === vaultId);
        if (!vaultEntry) throw new Error(`Vault '${vaultId}' not found`);

        // 활성 금고가 제거되면 시스템 금고로 전환
        if (this.activeVaultId === vaultId) {
            this.activeVaultId = SYSTEM_VAULT_ID;
        }

        const vault = this.vaults.get(vaultId);
        if (vault && !vault.isLocked) {
            vault.lock(true).catch(() => {});
        }

        this.vaults.delete(vaultId);
        this.vaultsConfig.otherVaults = this.vaultsConfig.otherVaults.filter((v) => v.id !== vaultId);
        this.saveConfig();
    }

    // 금고 상태 조회
    getVaultStatus(vaultId) {
        if (!this.checkVaultAvailability(vaultId)) return "offline";

        const vault = this.vaults.get(vaultId);
        if (!vault) return "locked";

        return vault.isLocked ? "locked" : "unlocked";
    }

    checkVaultAvailability(vaultId) {
        if (vaultId === SYSTEM_VAULT_ID) {
            try {
                return fs.existsSync(this.localkeysDir);
            } catch {
                return false;
            }
        }

        if (!this.vaultsConfig) return false;

        const vaultConfig = this.vaultsConfig.otherVaults.find((v) => v.id === vaultId);
        if (!vaultConfig) return false;

        try {
            return fs.existsSync(vaultConfig.path);
        } catch {
            return false;
        }
    }

    // 모든 금고 잠금 (비동기) - vaultsConfig도 초기화
    async lockAllVaults() {
        const promises = [];
        for (const vault of this.vaults.values()) {
            if (!vault.isLocked) {
                promises.push(vault.lock().catch(() => {}));
            }
        }
        await Promise.all(promises);
        this._resetVaultState();
    }

    // 모든 금고 잠금 (동기 - 앱 종료 시)
    lockAllVaultsSync() {
        for (const vault of this.vaults.values()) {
            if (!vault.isLocked) {
                try {
                    vault.lock(true);
                } catch {}
            }
        }
        this._resetVaultState();
    }

    // 이름으로 금고 인스턴스 직접 조회 (오프라인 복귀 시 자동 재잠금 해제)
    async getVaultByName(name) {
        if (name === SYSTEM_VAULT_NAME) return this.vaults.get(SYSTEM_VAULT_ID) || null;
        if (!this.vaultsConfig) return null;
        const entry = this.vaultsConfig.otherVaults.find((v) => v.name === name);
        if (!entry) return null;
        const vault = this.vaults.get(entry.id);
        if (!vault || vault.isLocked) return await this._reactivateVault(entry.id);
        return vault;
    }

    // 외부에서 특정 금고 인스턴스 접근
    getVaultInstance(vaultId) {
        return this.vaults.get(vaultId) || null;
    }

    // vaults.enc를 시스템 금고 키로 암호화하여 저장
    saveConfig() {
        if (!this.systemVault || this.systemVault.isLocked || !this.systemVault.key) {
            console.error("VaultManager: 시스템 금고가 잠겨있어 config를 저장할 수 없습니다");
            return;
        }

        if (!this.vaultsConfig) {
            this.vaultsConfig = this._defaultVaultsConfig();
        }

        try {
            fs.mkdirSync(this.localkeysDir, { recursive: true });
            const encrypted = CryptoUtil.encryptJson(this.vaultsConfig, this.systemVault.key);
            fs.writeFileSync(this.configPath, encrypted);
            try {
                fs.chmodSync(this.configPath, 0o600);
            } catch {}
        } catch (error) {
            console.error("VaultManager: config 저장 실패:", error.message);
        }
    }

    // --- private helpers ---

    // 오프라인 복귀 금고를 vaultsConfig에 저장된 키로 재잠금 해제
    async _reactivateVault(vaultId) {
        if (!this.vaultsConfig) return null;
        const vaultEntry = this.vaultsConfig.otherVaults.find((v) => v.id === vaultId);
        if (!vaultEntry || !vaultEntry.encryptionKey) return null;
        if (!this.checkVaultAvailability(vaultId)) return null;
        try {
            const vault = new Vault(vaultEntry.path);
            const keyBuffer = Buffer.from(vaultEntry.encryptionKey, "hex");
            await vault.unlockWithKey(keyBuffer);
            vault.setVaultId(vaultEntry.id);
            this._wireVaultConflict(vault);
            this.vaults.set(vaultId, vault);
            return vault;
        } catch {
            return null;
        }
    }

    _ensureSystemVaultInstance() {
        if (!this.systemVault) {
            this.systemVault = new Vault(this.localkeysDir);
            this.systemVault.setVaultId(SYSTEM_VAULT_ID);
            this._wireVaultConflict(this.systemVault);
            this.vaults.set(SYSTEM_VAULT_ID, this.systemVault);
        }
    }

    // vaults.enc를 시스템 금고 키로 복호화
    _loadVaultsConfig(key) {
        try {
            const data = fs.readFileSync(this.configPath);
            const parsed = CryptoUtil.decryptJson(data, key);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                this.vaultsConfig = parsed;
                if (!Array.isArray(this.vaultsConfig.otherVaults)) {
                    this.vaultsConfig.otherVaults = [];
                }
                return;
            }
        } catch {
            // 파일 없거나 복호화 실패-> 신규 생성
        }

        // vaults.enc 없거나 유효하지 않음-> 빈 설정으로 초기화 후 즉시 저장
        this.vaultsConfig = this._defaultVaultsConfig();
        this.saveConfig();
    }

    _defaultVaultsConfig() {
        return {
            version: 1,
            otherVaults: [],
        };
    }

    // 금고 항목을 config 및 Map에 등록하고 암호화 키를 제외한 공개 항목 반환
    _registerVaultEntry(name, lkvPath, vault) {
        const id = `vault_${Date.now()}`;
        vault.setVaultId(id);
        this._wireVaultConflict(vault);
        const vaultEntry = {
            id,
            name,
            path: lkvPath,
            encryptionKey: vault.key.toString("hex"),
            createdAt: new Date().toISOString(),
        };
        this.vaultsConfig.otherVaults.push(vaultEntry);
        this.vaults.set(id, vault);
        this.saveConfig();
        const { encryptionKey: _key, ...publicEntry } = vaultEntry;
        return publicEntry;
    }

    _resetVaultState() {
        this.vaults.clear();
        this.systemVault = null;
        this.vaultsConfig = null;
        this.activeVaultId = SYSTEM_VAULT_ID;
    }

    _validateVaultName(name) {
        if (!name || typeof name !== "string" || !name.trim()) {
            throw new Error("Vault name cannot be empty");
        }
        if (INVALID_NAME_CHARS.test(name)) {
            throw new Error('Vault name contains invalid characters (/, \\, *, ?, ", <, >, |)');
        }
        if (name.trim().length > 100) {
            throw new Error("Vault name is too long (max 100 characters)");
        }
    }
}

module.exports = VaultManager;

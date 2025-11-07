const crypto = require("crypto");

/**
 * 암호화 유틸리티 클래스
 * AES-256-GCM 암호화와 PBKDF2 키 파생 사용
 */
class CryptoUtil {
    /**
     * PBKDF2를 사용하여 비밀번호에서 키 파생
     * @param {string} password - 사용자 비밀번호
     * @param {Buffer} salt - 솔트 값
     * @param {number} iterations - 반복 횟수 (기본값: 100000)
     * @param {number} keyLength - 키 길이 (기본값: 32바이트)
     * @returns {Buffer} 파생된 키
     */
    static deriveKey(password, salt, iterations = 100000, keyLength = 32) {
        return crypto.pbkdf2Sync(password, salt, iterations, keyLength, "sha256");
    }

    /**
     * 랜덤 솔트 생성
     * @param {number} length - 솔트 길이 (기본값: 32바이트)
     * @returns {Buffer} 생성된 솔트
     */
    static generateSalt(length = 32) {
        return crypto.randomBytes(length);
    }

    /**
     * 데이터 암호화
     * @param {string} data - 암호화할 데이터
     * @param {Buffer} key - 암호화 키
     * @returns {Buffer} 암호화된 데이터 [IV 16바이트][Auth Tag 16바이트][암호문]
     */
    static encrypt(data, key) {
        const iv = crypto.randomBytes(16); // 초기화 벡터
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

        let encrypted = cipher.update(data, "utf8");
        encrypted = Buffer.concat([encrypted, cipher.final()]);

        const authTag = cipher.getAuthTag();

        // IV + AuthTag + 암호문 결합
        return Buffer.concat([iv, authTag, encrypted]);
    }

    /**
     * 데이터 복호화
     * @param {Buffer} encryptedData - 암호화된 데이터
     * @param {Buffer} key - 복호화 키
     * @returns {string} 복호화된 데이터
     */
    static decrypt(encryptedData, key) {
        // 데이터 분리: IV(16) + AuthTag(16) + 암호문
        const iv = encryptedData.slice(0, 16);
        const authTag = encryptedData.slice(16, 32);
        const ciphertext = encryptedData.slice(32);

        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString("utf8");
    }

    /**
     * JSON 데이터 암호화
     * @param {Object} jsonData - 암호화할 JSON 객체
     * @param {Buffer} key - 암호화 키
     * @returns {Buffer} 암호화된 데이터
     */
    static encryptJson(jsonData, key) {
        const jsonString = JSON.stringify(jsonData);
        return this.encrypt(jsonString, key);
    }

    /**
     * JSON 데이터 복호화
     * @param {Buffer} encryptedData - 암호화된 데이터
     * @param {Buffer} key - 복호화 키
     * @returns {Object} 복호화된 JSON 객체
     */
    static decryptJson(encryptedData, key) {
        const jsonString = this.decrypt(encryptedData, key);
        return JSON.parse(jsonString);
    }

    /**
     * 민감 정보 마스킹
     * @param {string} value - 마스킹할 값
     * @param {number} visibleChars - 표시할 문자 수 (기본값: 3)
     * @returns {string} 마스킹된 값
     */
    static maskSensitiveValue(value, visibleChars = 3) {
        if (!value || value.length <= visibleChars) {
            return "***";
        }

        const visible = value.substring(0, visibleChars);
        const masked = "*".repeat(value.length - visibleChars);
        return visible + masked;
    }

    /**
     * 안전한 랜덤 문자열 생성
     * @param {number} length - 문자열 길이
     * @returns {string} 랜덤 문자열
     */
    static generateRandomString(length = 16) {
        return crypto
            .randomBytes(length)
            .toString("base64")
            .replace(/[^a-zA-Z0-9]/g, "")
            .substring(0, length);
    }
}

module.exports = CryptoUtil;

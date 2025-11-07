const fs = require("fs");
const path = require("path");
const CryptoUtil = require("./crypto");

/**
 * 로그 관리 클래스
 * 모든 접근 기록을 안전하게 기록하고 민감 정보 마스킹
 */
class Logger {
    constructor(logPath) {
        this.logPath = logPath;
        this.maxLogEntries = 1000; // 최대 로그 항목 수
    }

    /**
     * 로그 기록
     * @param {string} message - 로그 메시지
     * @param {string} type - 로그 타입 (info, warning, error, access)
     */
    log(message, type = "info") {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            type,
            message: this._maskSensitiveInfo(message),
        };

        // 기존 로그 읽기
        let logs = [];
        if (fs.existsSync(this.logPath)) {
            try {
                const logData = fs.readFileSync(this.logPath, "utf8");
                logs = JSON.parse(logData);
            } catch (error) {
                // 로그 파일이 손상된 경우 새로 시작
                logs = [];
            }
        }

        // 새 로그 항목 추가
        logs.push(logEntry);

        // 최대 로그 항목 수 제한
        if (logs.length > this.maxLogEntries) {
            logs = logs.slice(-this.maxLogEntries);
        }

        // 로그 파일에 쓰기
        fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
    }

    /**
     * 접근 로그 기록
     * @param {string} action - 수행된 작업
     * @param {string} project - 프로젝트 이름
     * @param {string} secret - 시크릿 키 (선택사항)
     * @param {string} result - 결과 (success, denied, error)
     */
    logAccess(action, project, secret = null, result = "success") {
        let message = `${action} - Project: ${project}`;
        if (secret) {
            message += `, Secret: ${secret}`;
        }
        message += `, Result: ${result}`;

        this.log(message, "access");
    }

    /**
     * 보안 이벤트 로그 기록
     * @param {string} event - 보안 이벤트
     * @param {string} details - 상세 정보
     */
    logSecurity(event, details = "") {
        const message = `SECURITY: ${event}${details ? ` - ${details}` : ""}`;
        this.log(message, "warning");
    }

    /**
     * 오류 로그 기록
     * @param {string} error - 오류 메시지
     * @param {string} context - 컨텍스트 정보
     */
    logError(error, context = "") {
        const message = `ERROR: ${error}${context ? ` - Context: ${context}` : ""}`;
        this.log(message, "error");
    }

    /**
     * 모든 로그 가져오기
     * @returns {Array} 로그 항목 배열
     */
    getLogs() {
        if (!fs.existsSync(this.logPath)) {
            return [];
        }

        try {
            const logData = fs.readFileSync(this.logPath, "utf8");
            return JSON.parse(logData);
        } catch (error) {
            this.logError("Failed to read log file", error.message);
            return [];
        }
    }

    /**
     * 필터링된 로그 가져오기
     * @param {string} type - 필터링할 로그 타입
     * @param {number} limit - 최대 항목 수
     * @returns {Array} 필터링된 로그 항목 배열
     */
    getFilteredLogs(type = null, limit = 100) {
        let logs = this.getLogs();

        // 타입으로 필터링
        if (type) {
            logs = logs.filter((log) => log.type === type);
        }

        // 최신 항목부터 정렬 및 개수 제한
        return logs.reverse().slice(0, limit);
    }

    /**
     * 로그 통계 가져오기
     * @returns {Object} 로그 통계 정보
     */
    getLogStats() {
        const logs = this.getLogs();
        const stats = {
            total: logs.length,
            byType: {},
            recentActivity: [],
        };

        // 타입별 통계
        logs.forEach((log) => {
            stats.byType[log.type] = (stats.byType[log.type] || 0) + 1;
        });

        // 최근 활동 (최근 10개)
        stats.recentActivity = logs.slice(-10).reverse();

        return stats;
    }

    /**
     * 로그 파일 삭제
     */
    clearLogs() {
        if (fs.existsSync(this.logPath)) {
            fs.unlinkSync(this.logPath);
            this.log("Log file cleared", "info");
        }
    }

    /**
     * 민감 정보 마스킹 처리
     * @param {string} message - 원본 메시지
     * @returns {string} 민감 정보가 마스킹된 메시지
     * @private
     */
    _maskSensitiveInfo(message) {
        // API 키 패턴 마스킹 (sk-*, pk-*, etc.)
        message = message.replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, (match) => {
            return CryptoUtil.maskSensitiveValue(match, 6);
        });

        // 일반적인 키 패턴 마스킹 (긴 문자열)
        message = message.replace(/\b([a-zA-Z0-9]{32,})\b/g, (match) => {
            return CryptoUtil.maskSensitiveValue(match, 4);
        });

        // 비밀번호 관련 패턴 마스킹
        message = message.replace(/password[:\s=]+([^\s]+)/gi, (match, password) => {
            return match.replace(password, "***");
        });

        // 토큰 패턴 마스킹
        message = message.replace(/\b(token[:\s=]+)([^\s]+)/gi, (match, prefix, token) => {
            return prefix + CryptoUtil.maskSensitiveValue(token, 4);
        });

        return message;
    }

    /**
     * 로그 파일 압축 및 보관 (오래된 로그)
     * @param {number} daysToKeep - 보관할 일수
     */
    archiveLogs(daysToKeep = 30) {
        const logs = this.getLogs();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        // 최근 로그만 유지
        const recentLogs = logs.filter((log) => {
            return new Date(log.timestamp) > cutoffDate;
        });

        // 보관할 로그가 있다면 별도 파일로 저장
        const oldLogs = logs.filter((log) => {
            return new Date(log.timestamp) <= cutoffDate;
        });

        if (oldLogs.length > 0) {
            const archivePath = this.logPath.replace(".json", `_${Date.now()}.json`);
            fs.writeFileSync(archivePath, JSON.stringify(oldLogs, null, 2));
        }

        // 최근 로그로 파일 업데이트
        fs.writeFileSync(this.logPath, JSON.stringify(recentLogs, null, 2));

        this.log(`Archived ${oldLogs.length} old log entries`, "info");
    }
}

module.exports = Logger;

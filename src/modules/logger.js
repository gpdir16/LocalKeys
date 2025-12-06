const fs = require("fs");
const CryptoUtil = require("./crypto");

class Logger {
    constructor(logPath) {
        this.logPath = logPath;
        this.maxLogEntries = 1000;
        this.encryptionKey = null;
    }

    setEncryptionKey(key) {
        this.encryptionKey = key;
    }

    clearEncryptionKey() {
        this.encryptionKey = null;
    }

    log(message, category = "app") {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            category,
            message: this._maskSensitiveInfo(message),
        };

        let logs = this._readLogs();
        logs.push(logEntry);

        if (logs.length > this.maxLogEntries) {
            logs = logs.slice(-this.maxLogEntries);
        }

        this._writeLogs(logs);
    }

    logAccess(action, project, key) {
        const message = `${action} - Project: ${project}, Key: ${key}`;
        this.log(message, "access");
    }

    logApp(event) {
        this.log(event, "app");
    }

    logLock(event) {
        this.log(event, "lock");
    }

    getLogs() {
        if (!fs.existsSync(this.logPath)) {
            return [];
        }

        try {
            return this._readLogs();
        } catch (error) {
            console.error("Failed to read log file:", error.message);
            return [];
        }
    }

    getFilteredLogs(category = null, limit = 100) {
        let logs = this.getLogs();

        if (category) {
            logs = logs.filter((log) => log.category === category);
        }

        return logs.reverse().slice(0, limit);
    }

    getLogStats() {
        const logs = this.getLogs();
        const stats = {
            total: logs.length,
            byCategory: {},
            recentActivity: [],
        };

        logs.forEach((log) => {
            stats.byCategory[log.category] = (stats.byCategory[log.category] || 0) + 1;
        });

        stats.recentActivity = logs.slice(-10).reverse();

        return stats;
    }

    clearLogs() {
        if (fs.existsSync(this.logPath)) {
            fs.unlinkSync(this.logPath);
            this.log("Log file cleared", "info");
        }
    }

    _readLogs() {
        if (!this.encryptionKey) {
            return [];
        }

        if (!fs.existsSync(this.logPath)) {
            return [];
        }

        try {
            const fileData = fs.readFileSync(this.logPath);

            try {
                const decryptedData = CryptoUtil.decryptJson(fileData, this.encryptionKey);
                return decryptedData;
            } catch (error) {
                console.error("Failed to decrypt logs:", error.message);
                return [];
            }
        } catch (error) {
            console.error("Failed to read logs:", error.message);
            return [];
        }
    }

    _writeLogs(logs) {
        if (!this.encryptionKey) {
            console.warn("Encryption key not set - logs will not be saved");
            return;
        }

        try {
            const dataToWrite = CryptoUtil.encryptJson(logs, this.encryptionKey);
            fs.writeFileSync(this.logPath, dataToWrite);
        } catch (error) {
            console.error("Failed to write logs:", error.message);
        }
    }

    _maskSensitiveInfo(message) {
        message = message.replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, (match) => {
            return CryptoUtil.maskSensitiveValue(match, 6);
        });

        message = message.replace(/\b([a-zA-Z0-9]{32,})\b/g, (match) => {
            return CryptoUtil.maskSensitiveValue(match, 4);
        });

        message = message.replace(/password[:\s=]+([^\s]+)/gi, (match, password) => {
            return match.replace(password, "***");
        });

        message = message.replace(/\b(token[:\s=]+)([^\s]+)/gi, (match, prefix) => {
            return prefix + "***";
        });

        return message;
    }

    archiveLogs(daysToKeep = 30) {
        const logs = this.getLogs();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        const recentLogs = logs.filter((log) => {
            return new Date(log.timestamp) > cutoffDate;
        });

        const oldLogs = logs.filter((log) => {
            return new Date(log.timestamp) <= cutoffDate;
        });

        if (oldLogs.length > 0) {
            const archivePath = this.logPath.replace(".json", `_${Date.now()}.json`);
            fs.writeFileSync(archivePath, JSON.stringify(oldLogs, null, 2));
        }

        fs.writeFileSync(this.logPath, JSON.stringify(recentLogs, null, 2));

        this.log(`Archived ${oldLogs.length} old log entries`, "info");
    }
}

module.exports = Logger;

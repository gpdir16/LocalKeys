class NotificationManager {
    constructor() {
        this.currentNotification = null;
        this.autoCloseTimeout = null;
    }

    show(message, type = "info") {
        if (this.currentNotification) {
            this.hide();
        }

        this.saveToStorage(message, type);

        const messageEl = document.createElement("div");
        messageEl.className = `message message-${type}`;

        let icon = "✓";
        if (type === "error") icon = "✕";
        else if (type === "warning") icon = "⚠";

        messageEl.innerHTML = `
            <div class="message-content">
                <div class="message-header">
                    <div class="message-left">
                        <div class="message-icon">${icon}</div>
                        <div class="message-text">${this.escapeHtml(message)}</div>
                    </div>
                </div>
                <button class="message-close">×</button>
            </div>
        `;

        document.body.appendChild(messageEl);
        this.currentNotification = messageEl;

        setTimeout(() => {
            messageEl.classList.add("show");
        }, 10);

        const closeBtn = messageEl.querySelector(".message-close");
        closeBtn.addEventListener("click", () => {
            this.hide();
        });

        this.autoCloseTimeout = setTimeout(() => {
            this.hide();
        }, 10000);
    }

    hide() {
        if (!this.currentNotification) return;

        const messageEl = this.currentNotification;

        if (this.autoCloseTimeout) {
            clearTimeout(this.autoCloseTimeout);
            this.autoCloseTimeout = null;
        }

        messageEl.classList.add("hide");
        localStorage.removeItem("localkeys_notifications");

        setTimeout(() => {
            if (document.body.contains(messageEl)) {
                document.body.removeChild(messageEl);
            }
            this.currentNotification = null;
        }, 300);
    }

    success(message) {
        this.show(message, "success");
    }

    error(message) {
        this.show(message, "error");
    }

    warning(message) {
        this.show(message, "warning");
    }

    escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    saveToStorage(message, type) {
        try {
            localStorage.setItem(
                "localkeys_notifications",
                JSON.stringify({
                    message,
                    type,
                    timestamp: Date.now(),
                })
            );
        } catch (error) {
            console.error("Failed to save notification:", error);
        }
    }

    loadStored() {
        const stored = localStorage.getItem("localkeys_notifications");
        if (stored) {
            try {
                const notification = JSON.parse(stored);
                if (notification && notification.message) {
                    this.showStatic(notification.message, notification.type);
                }
            } catch (error) {
                console.error("Failed to load stored notifications:", error);
                localStorage.removeItem("localkeys_notifications");
            }
        }
    }

    showStatic(message, type) {
        if (this.currentNotification) {
            this.hide();
        }

        const messageEl = document.createElement("div");
        messageEl.className = `message message-${type}`;

        let icon = "✓";
        if (type === "error") icon = "✕";
        else if (type === "warning") icon = "⚠";

        messageEl.innerHTML = `
            <div class="message-content">
                <div class="message-header">
                    <div class="message-left">
                        <div class="message-icon">${icon}</div>
                        <div class="message-text">${this.escapeHtml(message)}</div>
                    </div>
                </div>
                <button class="message-close">×</button>
            </div>
        `;

        document.body.appendChild(messageEl);
        this.currentNotification = messageEl;

        messageEl.classList.add("show");

        const closeBtn = messageEl.querySelector(".message-close");
        closeBtn.addEventListener("click", () => {
            this.hide();
        });

        this.autoCloseTimeout = setTimeout(() => {
            this.hide();
        }, 10000);
    }
}

const notificationManager = new NotificationManager();

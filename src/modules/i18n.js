const { app } = require("electron");
const path = require("path");
const fs = require("fs");

class I18n {
    constructor() {
        this.currentLocale = "en";
        this.translations = {};
        this.fallbackTranslations = {};
        this.fallbackLocale = "en";
        this.supportedLocales = ["en", "ko"];
    }

    resolveLocale(preferredLocale) {
        const normalized = typeof preferredLocale === "string" ? preferredLocale.trim().toLowerCase() : "";

        if (normalized && normalized !== "system") {
            if (this.supportedLocales.includes(normalized)) return normalized;
            return this.fallbackLocale;
        }

        const systemLocale = app.getLocale();
        const languageCode = (systemLocale || "").split("-")[0].toLowerCase();
        return this.supportedLocales.includes(languageCode) ? languageCode : this.fallbackLocale;
    }

    initialize(preferredLocale = null) {
        this.currentLocale = this.resolveLocale(preferredLocale);

        this.loadTranslations();

        return this.currentLocale;
    }

    loadTranslations() {
        const localesDir = path.join(__dirname, "..", "locales");

        if (!fs.existsSync(localesDir)) {
            fs.mkdirSync(localesDir, { recursive: true });
        }

        const currentLocalePath = path.join(localesDir, `${this.currentLocale}.json`);
        const fallbackLocalePath = path.join(localesDir, `${this.fallbackLocale}.json`);

        try {
            if (fs.existsSync(currentLocalePath)) {
                this.translations = JSON.parse(fs.readFileSync(currentLocalePath, "utf8"));
            }
        } catch (error) {
            console.error(`Failed to load locale ${this.currentLocale}:`, error);
        }

        this.fallbackTranslations = {};
        if (this.currentLocale !== this.fallbackLocale) {
            try {
                if (fs.existsSync(fallbackLocalePath)) {
                    this.fallbackTranslations = JSON.parse(fs.readFileSync(fallbackLocalePath, "utf8"));
                }
            } catch (error) {
                console.error(`Failed to load fallback locale:`, error);
            }
        }
    }

    t(key, replacements = {}) {
        const keys = key.split(".");
        let translation = this.translations;

        for (const k of keys) {
            if (translation && typeof translation === "object") {
                translation = translation[k];
            } else {
                translation = undefined;
                break;
            }
        }

        if (translation === undefined && this.fallbackTranslations) {
            translation = this.fallbackTranslations;
            for (const k of keys) {
                if (translation && typeof translation === "object") {
                    translation = translation[k];
                } else {
                    translation = undefined;
                    break;
                }
            }
        }

        if (translation === undefined) {
            return key;
        }

        if (typeof translation !== "string") {
            return key;
        }

        const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        let result = translation;
        for (const [placeholder, value] of Object.entries(replacements)) {
            const pattern = new RegExp(`{{${escapeRegExp(placeholder)}}}`, "g");
            result = result.replace(pattern, () => String(value));
        }

        return result;
    }

    getLocale() {
        return this.currentLocale;
    }

    setLocale(locale) {
        this.currentLocale = this.resolveLocale(locale);
        this.loadTranslations();
    }

    getAllTranslations() {
        return {
            locale: this.currentLocale,
            translations: this.translations,
        };
    }
}

module.exports = I18n;

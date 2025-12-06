const { app } = require("electron");
const path = require("path");
const fs = require("fs");

class I18n {
    constructor() {
        this.currentLocale = "en";
        this.translations = {};
        this.fallbackLocale = "en";
    }

    initialize() {
        const systemLocale = app.getLocale();
        const languageCode = systemLocale.split("-")[0];
        const supportedLocales = ["en", "ko"];

        if (supportedLocales.includes(languageCode)) {
            this.currentLocale = languageCode;
        } else {
            this.currentLocale = this.fallbackLocale;
        }

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

        let result = translation;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(`{{${placeholder}}}`, "g"), value);
        }

        return result;
    }

    getLocale() {
        return this.currentLocale;
    }

    setLocale(locale) {
        this.currentLocale = locale;
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

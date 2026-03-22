// 금고 vault.enc 외부 변경 알림 및 대응 (i18n-helper.js 다음에 로드)
(function () {
    let handlingConflict = false;
    let stalePromptedThisSession = false;

    async function handleExternalChange() {
        if (handlingConflict) return;
        if (typeof i18n === "undefined") {
            window.alert("Vault file changed elsewhere. Reload the app or try again.");
            return;
        }
        handlingConflict = true;
        try {
            await i18n.init();

            if (window.localkeys?.vault?.trySilentConflictResolve) {
                const silent = await window.localkeys.vault.trySilentConflictResolve();
                if (silent && silent.success && silent.didSilent) {
                    return;
                }
            }

            if (typeof window.openVaultMergeModal === "function") {
                await window.openVaultMergeModal();
            } else {
                const title = i18n.t("vault.externalChange.title");
                const msg = i18n.t("vault.externalChange.message");
                window.alert(title + "\n\n" + msg);
                const reloadOk = window.confirm(i18n.t("vault.externalChange.reloadConfirm"));
                if (reloadOk) {
                    const r = await window.localkeys.vault.reloadFromDisk();
                    if (r.success) {
                        window.location.reload();
                    } else {
                        window.alert(i18n.t("vault.externalChange.reloadFailed", { error: r.error || "" }));
                    }
                } else {
                    const forceOk = window.confirm(i18n.t("vault.externalChange.forceConfirm"));
                    if (forceOk) {
                        const r = await window.localkeys.vault.saveForce();
                        if (!r.success) {
                            window.alert(i18n.t("vault.externalChange.saveForceFailed", { error: r.error || "" }));
                        }
                    }
                }
            }
        } finally {
            handlingConflict = false;
        }
    }

    async function handleStaleOnFocus() {
        if (stalePromptedThisSession) return;
        if (handlingConflict) return;
        if (typeof i18n === "undefined") return;
        if (!window.localkeys?.vault?.checkDiskStale) return;

        handlingConflict = true;
        try {
            const result = await window.localkeys.vault.checkDiskStale();
            if (!result.success || !result.stale) return;

            await i18n.init();

            if (window.localkeys?.vault?.trySilentConflictResolve) {
                const silent = await window.localkeys.vault.trySilentConflictResolve();
                if (silent && silent.success && silent.didSilent) {
                    return;
                }
            }

            stalePromptedThisSession = true;

            if (typeof window.openVaultMergeModal === "function") {
                await window.openVaultMergeModal();
            } else if (window.confirm(i18n.t("vault.externalChange.staleReloadConfirm"))) {
                const r = await window.localkeys.vault.reloadFromDisk();
                if (r.success) {
                    window.location.reload();
                } else {
                    window.alert(i18n.t("vault.externalChange.reloadFailed", { error: r.error || "" }));
                }
            }
        } finally {
            handlingConflict = false;
        }
    }

    function setup() {
        if (!window.localkeys?.vault?.onExternalChange) return;

        if (window.localkeys.vault.onVaultDataSynced) {
            window.localkeys.vault.onVaultDataSynced(() => {
                window.dispatchEvent(new CustomEvent("localkeys:vault-data-synced"));
            });
        }

        window.localkeys.vault.onExternalChange(() => {
            handleExternalChange().catch(() => {});
        });

        if (window.localkeys.onWindowFocusChanged && window.localkeys.vault.checkDiskStale) {
            window.localkeys.onWindowFocusChanged((focused) => {
                if (focused) {
                    handleStaleOnFocus().catch(() => {});
                }
            });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", setup);
    } else {
        setup();
    }
})();

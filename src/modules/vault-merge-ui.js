// 금고 충돌 diff / 병합 모달 (i18n-helper 다음, vault-external-change 이전에 로드)
(function () {
    function esc(s) {
        const d = document.createElement("div");
        d.textContent = s == null ? "" : String(s);
        return d.innerHTML;
    }

    function trMerge(t, key, err) {
        let msg = t(key);
        if (err) msg = msg.replace(/\{\{error\}\}/g, err);
        return msg;
    }

    window.openVaultMergeModal = async function () {
        if (typeof i18n === "undefined") {
            return;
        }
        await i18n.init();

        if (window.localkeys?.vault?.trySilentConflictResolve) {
            const silent = await window.localkeys.vault.trySilentConflictResolve();
            if (silent && silent.success && silent.didSilent) {
                return;
            }
        }

        const t = (key) => i18n.t(key);

        const res = await window.localkeys.vault.getVaultDiff();
        if (!res.success) {
            window.alert(trMerge(t, "vault.merge.loadFailed", res.error || ""));
            return;
        }

        const diff = res.diff || {};
        const rows = diff.rows || [];
        const hasRows = rows.length > 0;
        const conflictRows = rows.filter((r) => r.status === "conflict");

        await new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "lk-vault-merge-overlay";
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-modal", "true");

            const dialog = document.createElement("div");
            dialog.className = "lk-vault-merge-dialog";

            let keydownBlock;
            const finish = () => {
                if (keydownBlock) {
                    document.removeEventListener("keydown", keydownBlock, true);
                    keydownBlock = null;
                }
                overlay.remove();
                resolve();
            };

            dialog.innerHTML = `
                <header class="lk-vault-merge-header">
                    <h2 class="lk-vault-merge-title"></h2>
                    <p class="lk-vault-merge-subtitle lk-muted"></p>
                    <p class="lk-vault-merge-intro lk-muted"></p>
                </header>
                <div class="lk-vault-merge-table-scroll">
                    <table class="lk-vault-merge-table">
                        <thead>
                            <tr>
                                <th class="lk-vault-merge-col-project"></th>
                                <th class="lk-vault-merge-col-secret"></th>
                                <th class="lk-vault-merge-col-sess"></th>
                                <th class="lk-vault-merge-col-disk"></th>
                            </tr>
                        </thead>
                        <tbody class="lk-vault-merge-tbody"></tbody>
                    </table>
                </div>
                <p class="lk-vault-merge-hint lk-muted" hidden></p>
                <p class="lk-vault-merge-same lk-muted" hidden></p>
                <div class="lk-vault-merge-footer">
                    <button type="button" class="btn btn-secondary lk-merge-reload"></button>
                    <button type="button" class="btn btn-secondary lk-merge-overwrite"></button>
                    <button type="button" class="btn lk-merge-apply" hidden></button>
                    <button type="button" class="btn btn-secondary lk-merge-save-sync" hidden></button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            keydownBlock = (e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                }
            };
            document.addEventListener("keydown", keydownBlock, true);

            dialog.querySelector(".lk-vault-merge-title").textContent = t("vault.merge.title");
            const subtitleEl = dialog.querySelector(".lk-vault-merge-subtitle");
            const subtitleText = String(t("vault.merge.subtitle") || "").trim();
            if (subtitleText) {
                subtitleEl.textContent = subtitleText;
                subtitleEl.hidden = false;
            } else {
                subtitleEl.hidden = true;
            }
            dialog.querySelector(".lk-vault-merge-intro").textContent = t("vault.merge.intro");
            dialog.querySelector(".lk-vault-merge-col-project").textContent = t("vault.merge.colProject");
            dialog.querySelector(".lk-vault-merge-col-secret").textContent = t("vault.merge.colSecret");
            dialog.querySelector(".lk-vault-merge-col-sess").textContent = t("vault.merge.colSession");
            dialog.querySelector(".lk-vault-merge-col-disk").textContent = t("vault.merge.colDisk");
            dialog.querySelector(".lk-merge-reload").textContent = t("vault.merge.reloadDisk");
            dialog.querySelector(".lk-merge-overwrite").textContent = t("vault.merge.overwriteDisk");
            dialog.querySelector(".lk-merge-apply").textContent = t("vault.merge.applyMerge");
            dialog.querySelector(".lk-merge-save-sync").textContent = t("vault.merge.saveSync");
            dialog.querySelector(".lk-vault-merge-same").textContent = t("vault.merge.sameContent");

            const tbody = dialog.querySelector(".lk-vault-merge-tbody");
            const tableScroll = dialog.querySelector(".lk-vault-merge-table-scroll");
            const sameEl = dialog.querySelector(".lk-vault-merge-same");
            const hintEl = dialog.querySelector(".lk-vault-merge-hint");
            const btnApply = dialog.querySelector(".lk-merge-apply");
            const btnSaveSync = dialog.querySelector(".lk-merge-save-sync");
            const btnReload = dialog.querySelector(".lk-merge-reload");

            if (!hasRows) {
                tableScroll.hidden = true;
                hintEl.hidden = true;
                sameEl.hidden = false;
                btnApply.hidden = true;
                btnSaveSync.hidden = false;
                btnReload.classList.remove("btn-secondary");
            } else {
                tableScroll.hidden = false;
                sameEl.hidden = true;
                hintEl.hidden = false;
                btnSaveSync.hidden = true;
                // 같은 키에 세션·디스크 값이 모두 있고 다른 경우(conflict)가 없을 때만 자동 병합 가능
                const canAutoMerge = conflictRows.length === 0;
                btnApply.hidden = !canAutoMerge;
                hintEl.textContent = canAutoMerge ? t("vault.merge.autoMergeHint") : t("vault.merge.conflictHint");

                for (const row of rows) {
                    const tr = document.createElement("tr");

                    if (row.kind === "project") {
                        tr.innerHTML = `
                            <td>${esc(row.project)}</td>
                            <td>—</td>
                            <td>${row.status === "only_local" ? "✓" : "—"}</td>
                            <td>${row.status === "only_remote" ? "✓" : "—"}</td>
                        `;
                    } else if (row.status === "conflict") {
                        tr.classList.add("lk-vault-merge-row-conflict");
                        tr.innerHTML = `
                            <td>${esc(row.project)}</td>
                            <td>${esc(row.key)}</td>
                            <td><code>${esc(row.localPreview)}</code></td>
                            <td><code>${esc(row.remotePreview)}</code></td>
                        `;
                    } else {
                        tr.innerHTML = `
                            <td>${esc(row.project)}</td>
                            <td>${esc(row.key)}</td>
                            <td>${row.status === "only_local" ? "✓" : "—"}</td>
                            <td>${row.status === "only_remote" ? "✓" : "—"}</td>
                        `;
                    }
                    tbody.appendChild(tr);
                }
            }

            dialog.querySelector(".lk-merge-reload").addEventListener("click", async () => {
                const r = await window.localkeys.vault.reloadFromDisk();
                if (r.success) window.location.reload();
                else window.alert(trMerge(t, "vault.merge.mergeFailed", r.error || ""));
            });

            dialog.querySelector(".lk-merge-overwrite").addEventListener("click", async () => {
                if (!window.confirm(t("vault.externalChange.forceConfirm"))) return;
                const r = await window.localkeys.vault.saveForce();
                if (r.success) window.location.reload();
                else window.alert(trMerge(t, "vault.merge.mergeFailed", r.error || ""));
            });

            btnApply.addEventListener("click", async () => {
                const r = await window.localkeys.vault.applyMerge({ conflicts: {} });
                if (r.success) window.location.reload();
                else window.alert(trMerge(t, "vault.merge.mergeFailed", r.error || ""));
            });

            btnSaveSync.addEventListener("click", async () => {
                const r = await window.localkeys.vault.saveForce();
                if (r.success) window.location.reload();
                else window.alert(trMerge(t, "vault.merge.mergeFailed", r.error || ""));
            });
        });
    };
})();

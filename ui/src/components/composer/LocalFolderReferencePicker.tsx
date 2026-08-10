import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../../i18n";
import {
  clearPersistedLocalDirectory,
  loadPersistedLocalDirectory,
  persistLocalDirectory,
  pickLocalDirectory,
  queryLocalDirectoryPermission,
  requestLocalDirectoryPermission,
  scanLocalDirectoryImages,
  supportsLocalDirectoryPicker,
  toggleLocalFolderSelection,
  type LocalDirectoryHandle,
  type LocalFolderImage,
  type LocalFolderPermission,
} from "../../lib/localFolderReferences";

type PreviewImage = LocalFolderImage & { previewUrl: string };

type Props = {
  maxSelection: number;
  onSubmit: (files: File[]) => Promise<number>;
};

function withPreviewUrls(images: LocalFolderImage[]): PreviewImage[] {
  return images.map((image) => ({ ...image, previewUrl: URL.createObjectURL(image.file) }));
}

function revokePreviewUrls(images: PreviewImage[]): void {
  for (const image of images) URL.revokeObjectURL(image.previewUrl);
}

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function LocalFolderReferencePicker({ maxSelection, onSubmit }: Props) {
  const { t, locale } = useI18n();
  const supported = supportsLocalDirectoryPicker();
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [handle, setHandle] = useState<LocalDirectoryHandle | null>(null);
  const [folderName, setFolderName] = useState("");
  const [permission, setPermission] = useState<LocalFolderPermission | null>(null);
  const [images, setImages] = useState<PreviewImage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const virtualizer = useVirtualizer({
    count: images.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 86,
    horizontal: true,
    overscan: 5,
  });

  const imageById = useMemo(
    () => new Map(images.map((image) => [image.id, image])),
    [images],
  );

  const replaceImages = (next: LocalFolderImage[]) => {
    setImages(withPreviewUrls(next));
    setSelectedIds([]);
    setFailedIds(new Set());
    setFocusedId(next[0]?.id ?? null);
  };

  const scanHandle = async (target: LocalDirectoryHandle): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      const next = await scanLocalDirectoryImages(target);
      replaceImages(next);
      setPermission("granted");
      if (next.length === 0) setStatus(t("prompt.localFolder.empty"));
    } catch {
      setStatus(t("prompt.localFolder.scanFailed"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => revokePreviewUrls(images), [images]);

  useEffect(() => {
    setSelectedIds((current) => current.slice(0, Math.max(0, maxSelection)));
  }, [maxSelection]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      try {
        const persisted = await loadPersistedLocalDirectory();
        if (cancelled || !persisted) return;
        const nextPermission = await queryLocalDirectoryPermission(persisted.handle);
        if (cancelled) return;
        setHandle(persisted.handle);
        setFolderName(persisted.name);
        setPermission(nextPermission);
        if (nextPermission !== "granted") return;
        const next = await scanLocalDirectoryImages(persisted.handle);
        if (cancelled) return;
        replaceImages(next);
        if (next.length === 0) setStatus(t("prompt.localFolder.empty"));
      } catch {
        if (!cancelled) setStatus(t("prompt.localFolder.restoreFailed"));
      }
    })();
    return () => { cancelled = true; };
  }, [supported, locale]);

  const chooseFolder = async () => {
    setStatus(null);
    try {
      const nextHandle = await pickLocalDirectory();
      await persistLocalDirectory(nextHandle);
      setHandle(nextHandle);
      setFolderName(nextHandle.name);
      await scanHandle(nextHandle);
    } catch (error) {
      if (!isPickerCancellation(error)) setStatus(t("prompt.localFolder.chooseFailed"));
    }
  };

  const reauthorize = async () => {
    if (!handle) return;
    try {
      const nextPermission = await requestLocalDirectoryPermission(handle);
      setPermission(nextPermission);
      if (nextPermission === "granted") await scanHandle(handle);
      else setStatus(t("prompt.localFolder.permissionDenied"));
    } catch {
      setStatus(t("prompt.localFolder.permissionDenied"));
    }
  };

  const clearFolder = async () => {
    try {
      await clearPersistedLocalDirectory();
      setHandle(null);
      setFolderName("");
      setPermission(null);
      replaceImages([]);
      setStatus(null);
    } catch {
      setStatus(t("prompt.localFolder.clearFailed"));
    }
  };

  const toggleImage = (id: string) => {
    if (failedIds.has(id)) return;
    setSelectedIds((current) => {
      const next = toggleLocalFolderSelection(current, id, maxSelection);
      if (next.length === current.length && !current.includes(id)) {
        setStatus(t("prompt.localFolder.limit", { max: maxSelection }));
      } else {
        setStatus(null);
      }
      return next;
    });
  };

  const moveFocus = (id: string, delta: -1 | 1) => {
    const index = images.findIndex((image) => image.id === id);
    const nextIndex = Math.max(0, Math.min(images.length - 1, index + delta));
    const nextId = images[nextIndex]?.id;
    if (!nextId) return;
    setFocusedId(nextId);
    virtualizer.scrollToIndex(nextIndex, { align: "auto" });
    requestAnimationFrame(() => itemRefs.current.get(nextId)?.focus());
  };

  const onImageKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus(id, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggleImage(id);
    }
  };

  const submit = async () => {
    const files = selectedIds
      .filter((id) => !failedIds.has(id))
      .map((id) => imageById.get(id)?.file)
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    setBusy(true);
    try {
      const added = await onSubmit(files);
      if (added > 0) {
        setSelectedIds([]);
        setStatus(t("prompt.localFolder.added", { count: added }));
      }
    } catch {
      setStatus(t("prompt.localFolder.addFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return <p className="local-folder-picker__unsupported">{t("prompt.localFolder.unsupported")}</p>;
  }

  return (
    <section className="local-folder-picker" aria-label={t("prompt.localFolder.ariaLabel")}>
      <div className="local-folder-picker__header">
        <div className="local-folder-picker__title">
          <strong>{folderName || t("prompt.localFolder.title")}</strong>
          <span>{handle ? t("prompt.localFolder.count", { count: images.length }) : t("prompt.localFolder.description")}</span>
        </div>
        <div className="local-folder-picker__actions">
          <button type="button" onClick={() => void chooseFolder()} disabled={busy}>
            {handle ? t("prompt.localFolder.switch") : t("prompt.localFolder.choose")}
          </button>
          {handle && permission === "granted" ? (
            <button type="button" onClick={() => void scanHandle(handle)} disabled={busy}>
              {t("prompt.localFolder.refresh")}
            </button>
          ) : null}
          {handle && permission !== "granted" ? (
            <button type="button" onClick={() => void reauthorize()} disabled={busy}>
              {t("prompt.localFolder.reauthorize")}
            </button>
          ) : null}
          {handle ? (
            <button type="button" onClick={() => void clearFolder()} disabled={busy}>
              {t("prompt.localFolder.clear")}
            </button>
          ) : null}
        </div>
      </div>

      {handle && permission === "granted" && images.length > 0 ? (
        <div ref={scrollRef} className="local-folder-picker__scroll" role="listbox" aria-multiselectable="true">
          <div className="local-folder-picker__virtual" style={{ width: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const image = images[virtualItem.index];
              const selectedIndex = selectedIds.indexOf(image.id);
              const failed = failedIds.has(image.id);
              return (
                <button
                  key={image.id}
                  ref={(node) => {
                    if (node) itemRefs.current.set(image.id, node);
                    else itemRefs.current.delete(image.id);
                  }}
                  type="button"
                  role="option"
                  aria-selected={selectedIndex >= 0}
                  aria-label={image.name}
                  className={`local-folder-picker__item${selectedIndex >= 0 ? " is-selected" : ""}${failed ? " is-failed" : ""}`}
                  style={{ transform: `translateX(${virtualItem.start}px)` }}
                  tabIndex={focusedId === image.id || (!focusedId && virtualItem.index === 0) ? 0 : -1}
                  onFocus={() => setFocusedId(image.id)}
                  onClick={() => toggleImage(image.id)}
                  onKeyDown={(event) => onImageKeyDown(event, image.id)}
                  disabled={failed}
                  title={image.name}
                >
                  {failed ? (
                    <span className="local-folder-picker__broken" aria-hidden="true">!</span>
                  ) : (
                    <img
                      src={image.previewUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={() => {
                        setFailedIds((current) => new Set(current).add(image.id));
                        setSelectedIds((current) => current.filter((id) => id !== image.id));
                      }}
                    />
                  )}
                  <span className="local-folder-picker__check" aria-hidden="true">
                    {selectedIndex >= 0 ? selectedIndex + 1 : ""}
                  </span>
                  <span className="local-folder-picker__name">{image.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {handle && permission !== "granted" ? (
        <p className="local-folder-picker__status">{t("prompt.localFolder.permissionRequired", { name: folderName })}</p>
      ) : null}
      {status ? <p className="local-folder-picker__status" role="status">{status}</p> : null}
      {failedIds.size > 0 ? (
        <p className="local-folder-picker__status">{t("prompt.localFolder.unavailable", { count: failedIds.size })}</p>
      ) : null}

      {handle && permission === "granted" ? (
        <div className="local-folder-picker__footer">
          <span>{t("prompt.localFolder.selected", { count: selectedIds.length, max: maxSelection })}</span>
          <button type="button" onClick={() => void submit()} disabled={busy || selectedIds.length === 0 || maxSelection === 0}>
            {t("prompt.localFolder.send")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

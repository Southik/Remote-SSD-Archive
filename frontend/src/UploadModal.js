import React, { useCallback, useEffect, useRef, useState } from "react";
import { uploadFile, MAX_FILE_MB } from "./api";

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

export default function UploadModal({ path, onClose, onUploaded }) {
  const [items, setItems] = useState([]); // {file, progress, status, error}
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const addFiles = useCallback((fileList) => {
    const next = Array.from(fileList).map((file) => {
      const tooBig = file.size > MAX_FILE_MB * 1048576;
      return {
        file,
        progress: 0,
        status: tooBig ? "error" : "ready",
        error: tooBig ? `Larger than ${MAX_FILE_MB} MB` : "",
      };
    });
    setItems((cur) => [...cur, ...next]);
  }, []);

  const update = (i, patch) =>
    setItems((cur) => cur.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const start = async () => {
    setBusy(true);
    const done = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.status !== "ready") continue;
      update(i, { status: "uploading", progress: 0 });
      try {
        await uploadFile(path, it.file, (p) => update(i, { progress: p }));
        update(i, { status: "done", progress: 100 });
        done.push({ path, name: it.file.name, size: it.file.size });
      } catch (err) {
        update(i, { status: "error", error: err.message });
      }
    }
    setBusy(false);
    if (done.length) onUploaded(done);
  };

  const readyCount = items.filter((i) => i.status === "ready").length;
  const allFinished = items.length > 0 && items.every((i) => i.status === "done" || i.status === "error");

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h2>Upload to {path.length ? path.join(" / ") : "SSD"}</h2>

        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
        >
          <p><strong>Drop files here</strong> or click to choose</p>
          <p className="muted">Max {MAX_FILE_MB} MB per file. Files are reviewed by an admin before they appear.</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
        </div>

        {items.length > 0 && (
          <ul className="upload-list">
            {items.map((it, i) => (
              <li key={i}>
                <div className="row">
                  <span className="name">{it.file.name}</span>
                  <span className="muted">{fmt(it.file.size)}</span>
                </div>
                {it.status === "uploading" && (
                  <div className="bar"><div style={{ width: `${it.progress}%` }} /></div>
                )}
                {it.status === "done" && <span className="ok">Uploaded, waiting for approval</span>}
                {it.status === "error" && <span className="err">{it.error}</span>}
              </li>
            ))}
          </ul>
        )}

        <div className="actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            {allFinished ? "Close" : "Cancel"}
          </button>
          <button className="btn primary" onClick={start} disabled={busy || readyCount === 0}>
            {busy ? "Uploading…" : `Upload ${readyCount || ""} file${readyCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
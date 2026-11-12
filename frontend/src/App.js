import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { getTree, createFolder, validName } from "./api";
import UploadModal from "./UploadModal";

/* ---------- helpers ---------- */
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isPrefix = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);
const fmtSize = (b) =>
  b == null ? "—" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;

function buildTree(base, pendingFolders, pendingFiles) {
  const root = base
    ? JSON.parse(JSON.stringify(base))
    : { name: "SSD", type: "folder", children: [] };
  const ensure = (parts) => {
    let node = root;
    for (const p of parts) {
      let c = node.children.find((x) => x.type === "folder" && x.name === p);
      if (!c) {
        c = { name: p, type: "folder", children: [], pending: true };
        node.children.push(c);
      }
      node = c;
    }
    return node;
  };
  pendingFolders.forEach((p) => ensure(p));
  pendingFiles.forEach((f) => {
    const n = ensure(f.path);
    if (!n.children.some((c) => c.type === "file" && c.name === f.name)) {
      n.children.push({ name: f.name, type: "file", size: f.size, pending: true });
    }
  });
  return root;
}

function getNode(tree, path) {
  let node = tree;
  for (const p of path) {
    node = node.children?.find((c) => c.type === "folder" && c.name === p);
    if (!node) return null;
  }
  return node;
}

/* ---------- icons ---------- */
const FolderIcon = ({ size = 64 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M6 16a4 4 0 0 1 4-4h14l6 6h24a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#5ab0f6" />
    <path d="M6 24a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#7cc4ff" />
  </svg>
);
const FileIcon = ({ name, size = 64 }) => {
  const ext = name.includes(".") ? name.split(".").pop().slice(0, 4).toUpperCase() : "";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M14 6h25l13 13v37a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="#f4f5f7" stroke="#b8bec9" strokeWidth="2" />
      <path d="M39 6v13h13" fill="#dfe3ea" stroke="#b8bec9" strokeWidth="2" />
      {ext && <text x="32" y="46" textAnchor="middle" fontSize="11" fontWeight="700" fill="#6b7482">{ext}</text>}
    </svg>
  );
};

/* ---------- sidebar tree ---------- */
function TreeNode({ node, path, current, onOpen }) {
  const [open, setOpen] = useState(path.length === 0);
  const folders = node.children
    .filter((c) => c.type === "folder")
    .sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    if (isPrefix(path, current)) setOpen(true);
  }, [current, path]);

  return (
    <li>
      <div className={`tree-row ${samePath(path, current) ? "active" : ""}`}>
        <button
          className="chev"
          style={{ visibility: folders.length ? "visible" : "hidden" }}
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? "▾" : "▸"}
        </button>
        <button className="tree-label" onClick={() => onOpen(path)}>
          <FolderIcon size={18} />
          <span>{path.length === 0 ? "SSD" : node.name}</span>
        </button>
      </div>
      {open && folders.length > 0 && (
        <ul>
          {folders.map((f) => (
            <TreeNode key={f.name} node={f} path={[...path, f.name]} current={current} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ---------- new folder dialog ---------- */
function NewFolderModal({ existing, onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const n = name.trim();
    const v = validName(n);
    if (v) return setErr(v);
    if (existing.some((x) => x.toLowerCase() === n.toLowerCase())) {
      return setErr("An item with this name already exists.");
    }
    setBusy(true);
    try {
      await onCreate(n);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal small" onSubmit={submit}>
        <h2>New Folder</h2>
        <input
          autoFocus
          className="text-input"
          placeholder="Folder name"
          value={name}
          onChange={(e) => { setName(e.target.value); setErr(""); }}
        />
        {err && <p className="err">{err}</p>}
        <p className="muted">The folder is created on the SSD after admin approval.</p>
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </div>
  );
}

/* ---------- main app ---------- */
export default function App() {
  const [baseTree, setBaseTree] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [pendingFolders, setPendingFolders] = useState([]); // arrays of names
  const [pendingFiles, setPendingFiles] = useState([]); // {path, name, size}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [nav, setNav] = useState({ stack: [[]], idx: 0 });
  const [view, setView] = useState("grid");
  const [query, setQuery] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);

  const path = nav.stack[nav.idx];
  const go = useCallback(
    (p) => setNav((n) => ({ stack: [...n.stack.slice(0, n.idx + 1), p], idx: n.idx + 1 })),
    []
  );
  const back = () => setNav((n) => ({ ...n, idx: Math.max(0, n.idx - 1) }));
  const forward = () => setNav((n) => ({ ...n, idx: Math.min(n.stack.length - 1, n.idx + 1) }));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getTree();
      setBaseTree(data.tree || null);
      setUpdated(data.updated || null);
      setTruncated(Boolean(data.truncated));
      setPendingFolders((data.pendingFolders || []).map((p) => p.split("/").filter(Boolean)));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const tree = useMemo(
    () => buildTree(baseTree, pendingFolders, pendingFiles),
    [baseTree, pendingFolders, pendingFiles]
  );
  const node = getNode(tree, path);

  const items = useMemo(() => {
    if (!node) return [];
    const q = query.trim().toLowerCase();
    return [...node.children]
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
  }, [node, query]);

  const handleCreateFolder = async (name) => {
    await createFolder(path, name);
    setPendingFolders((cur) => [...cur, [...path, name]]);
    setShowNewFolder(false);
  };

  const handleUploaded = (done) => setPendingFiles((cur) => [...cur, ...done]);

  const open = (item) => item.type === "folder" && go([...path, item.name]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-title">Locations</div>
        <ul className="tree">
          <TreeNode node={tree} path={[]} current={path} onOpen={go} />
        </ul>
      </aside>

      <main className="main">
        <header className="toolbar">
          <div className="nav-btns">
            <button className="icon-btn" onClick={back} disabled={nav.idx === 0} aria-label="Back">‹</button>
            <button className="icon-btn" onClick={forward} disabled={nav.idx >= nav.stack.length - 1} aria-label="Forward">›</button>
          </div>
          <nav className="crumbs" aria-label="Path">
            <button onClick={() => go([])} className={path.length === 0 ? "current" : ""}>SSD</button>
            {path.map((seg, i) => (
              <React.Fragment key={i}>
                <span className="sep">›</span>
                <button
                  onClick={() => go(path.slice(0, i + 1))}
                  className={i === path.length - 1 ? "current" : ""}
                >
                  {seg}
                </button>
              </React.Fragment>
            ))}
          </nav>
          <div className="spacer" />
          <div className="seg">
            <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")} title="Icons">▦</button>
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")} title="List">☰</button>
          </div>
          <input className="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" onClick={() => setShowNewFolder(true)}>New Folder</button>
          <button className="btn primary" onClick={() => setShowUpload(true)}>Upload here</button>
        </header>

        <section className="content">
          {error && (
            <div className="banner err-banner">
              Could not load the SSD listing: {error}{" "}
              <button className="link" onClick={refresh}>Retry</button>
            </div>
          )}
          {truncated && (
            <div className="banner warn-banner">The SSD is very large, so only part of it is listed here.</div>
          )}
          {!node && !loading && (
            <div className="empty">
              <p>This folder no longer exists.</p>
              <button className="btn" onClick={() => go([])}>Go to SSD</button>
            </div>
          )}
          {node && items.length === 0 && !loading && (
            <div className="empty">
              <FolderIcon size={72} />
              <p>{query ? "No matches." : "This folder is empty."}</p>
              {!query && <button className="btn primary" onClick={() => setShowUpload(true)}>Upload here</button>}
            </div>
          )}

          {node && items.length > 0 && view === "grid" && (
            <div className="grid">
              {items.map((it) => (
                <button
                  key={it.type + it.name}
                  className={`tile ${it.pending ? "pending" : ""}`}
                  onClick={() => open(it)}
                  title={it.pending ? `${it.name} (waiting for approval)` : it.name}
                  style={{ cursor: it.type === "folder" ? "pointer" : "default" }}
                >
                  {it.type === "folder" ? <FolderIcon /> : <FileIcon name={it.name} />}
                  <span className="tile-name">{it.name}</span>
                  {it.pending && <span className="badge">Pending</span>}
                </button>
              ))}
            </div>
          )}

          {node && items.length > 0 && view === "list" && (
            <table className="list">
              <thead>
                <tr><th>Name</th><th>Size</th><th>Status</th></tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.type + it.name} onClick={() => open(it)} className={it.type === "folder" ? "clickable" : ""}>
                    <td>
                      <span className="inline-icon">
                        {it.type === "folder" ? <FolderIcon size={20} /> : <FileIcon name={it.name} size={20} />}
                      </span>
                      {it.name}
                    </td>
                    <td>{it.type === "folder" ? "—" : fmtSize(it.size)}</td>
                    <td>{it.pending ? <span className="badge">Pending</span> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <footer className="statusbar">
          <span>{node ? `${node.children.length} item${node.children.length === 1 ? "" : "s"}` : ""}</span>
          <span>
            {loading
              ? "Syncing…"
              : updated
              ? `Last synced from SSD: ${new Date(updated).toLocaleString()}`
              : "SSD not synced yet"}{" "}
            <button className="link" onClick={refresh}>Refresh</button>
          </span>
        </footer>
      </main>

      {showUpload && (
        <UploadModal path={path} onClose={() => setShowUpload(false)} onUploaded={handleUploaded} />
      )}
      {showNewFolder && (
        <NewFolderModal
          existing={(node?.children || []).map((c) => c.name)}
          onCancel={() => setShowNewFolder(false)}
          onCreate={handleCreateFolder}
        />
      )}
    </div>
  );
}
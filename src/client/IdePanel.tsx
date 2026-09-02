import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { FsRequest, FsResponse, WorkspaceInfo } from "../shared/workspace";

const CODE_EXTENSIONS = /\.(c|cc|cpp|css|go|h|hpp|html?|java|js|jsx|json|md|mjs|py|rb|rs|sql|sh|swift|ts|tsx|toml|vue|xml|yaml|yml)$/i;

function filesFromListing(data: string): string[] {
  return data.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("(") && !line.endsWith("/") && CODE_EXTENSIONS.test(line));
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

interface FileNode { type: "file"; name: string; path: string }
interface FolderNode { type: "folder"; name: string; path: string; children: TreeNode[] }
type TreeNode = FileNode | FolderNode;

function buildTree(paths: string[]): TreeNode[] {
  const root: FolderNode = { type: "folder", name: "", path: "", children: [] };
  for (const path of paths) {
    const parts = path.split("/");
    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1] ?? path;
    let dir = root;
    for (const [i, part] of dirParts.entries()) {
      const dirPath = dirParts.slice(0, i + 1).join("/");
      let child = dir.children.find((c): c is FolderNode => c.type === "folder" && c.path === dirPath);
      if (!child) { child = { type: "folder", name: part, path: dirPath, children: [] }; dir.children.push(child); }
      dir = child;
    }
    dir.children.push({ type: "file", name: fileName, path });
  }
  const sort = (node: FolderNode) => {
    node.children.sort((a, b) => (a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
    for (const child of node.children) if (child.type === "folder") sort(child);
  };
  sort(root);
  return root.children;
}

export function IdePanel({ workspace, canEdit, onRequest, onClose, onOpenConnections, embedded = false }: {
  workspace: WorkspaceInfo;
  canEdit: boolean;
  onRequest: (req: FsRequest) => Promise<FsResponse>;
  onClose: () => void;
  onOpenConnections?: () => void;
  embedded?: boolean;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const loadFiles = useCallback(async () => {
    if (workspace.kind === "none" || !workspace.online) { setFiles([]); setSelected(""); setContent(""); setDirty(false); setError(null); return; }
    setLoading(true); setError(null);
    const response = await onRequest({ op: "list", path: "", depth: 4, deny: [] });
    if (!response.ok) setError(response.error); else setFiles(filesFromListing(response.data));
    setLoading(false);
  }, [onRequest, workspace.kind, workspace.online]);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

  const openFile = useCallback(async (path: string) => {
    setSelected(path); setLoading(true); setError(null);
    const response = await onRequest({ op: "read", path, offset: 0, limit: 64_000 });
    if (!response.ok) { setError(response.error); setContent(""); } else { setContent(response.data); setDirty(false); }
    setLoading(false);
  }, [onRequest]);

  const saveFile = useCallback(async () => {
    if (!selected || !canEdit) return;
    setSaving(true); setError(null);
    const response = await onRequest({ op: "write", path: selected, content, deny: [] });
    if (!response.ok) setError(response.error); else { setDirty(false); await loadFiles(); }
    setSaving(false);
  }, [canEdit, content, loadFiles, onRequest, selected]);

  const createFile = useCallback(async () => {
    const path = newPath.trim();
    if (!path || !canEdit) return;
    setSaving(true); setError(null);
    const response = await onRequest({ op: "write", path, content: "", deny: [] });
    if (!response.ok) setError(response.error); else { setNewPath(""); await loadFiles(); await openFile(path); }
    setSaving(false);
  }, [canEdit, loadFiles, newPath, onRequest, openFile]);

  const tree = useMemo(() => buildTree(files), [files]);

  const toggleFolder = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const renderTree = (nodes: TreeNode[], depth: number): ReactNode[] => nodes.flatMap((node) => {
    const indent = { paddingLeft: `${depth * 14 + 8}px` };
    if (node.type === "folder") {
      const isCollapsed = collapsed.has(node.path);
      return [
        <button type="button" key={node.path} className="ide-folder" style={indent} onClick={() => toggleFolder(node.path)}>
          <span className="ide-folder-caret">{isCollapsed ? "▸" : "▾"}</span>{node.name}
        </button>,
        ...(isCollapsed ? [] : renderTree(node.children, depth + 1)),
      ];
    }
    return [
      <button type="button" key={node.path} title={node.path} style={indent} className={`ide-file ${selected === node.path ? "ide-file-selected" : ""}`} onClick={() => void openFile(node.path)}>{node.name}</button>,
    ];
  });

  const status = useMemo(() => {
    if (workspace.kind === "none") return "Connect a workspace to begin.";
    if (!workspace.online) return "The workspace host is offline.";
    return canEdit ? "Changes save to the connected workspace." : "Read-only access for this member.";
  }, [canEdit, workspace.kind, workspace.online]);

  return (
    <div className={embedded ? "ide-embedded" : "modal-scrim"} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? "ide-shell" : "modal ide-modal"} role="dialog" aria-label="IDE" onClick={(event) => event.stopPropagation()}>
        {embedded ? <div className="ide-context-bar"><strong>IDE</strong><span className="ide-status">{status}</span></div> : <header className="modal-head"><div><h2>IDE</h2><p className="ide-status">{status}</p></div><button className="icon" onClick={onClose} aria-label="Close IDE">✕</button></header>}
        <div className="ide-toolbar"><button type="button" onClick={() => void loadFiles()} disabled={loading}>Refresh</button>{workspace.kind === "none" && onOpenConnections && <button type="button" className="primary" onClick={onOpenConnections}>Open Connections</button>}{canEdit && <form onSubmit={(event) => { event.preventDefault(); void createFile(); }} className="ide-new-file"><input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="src/new-file.ts" aria-label="New file path" /><button type="submit" disabled={!newPath.trim() || saving}>New file</button></form>}</div>
        {workspace.kind === "none" ? <div className="ide-empty-state"><strong>Connect a workspace to edit code</strong><span>Choose a local folder or GitHub repository from Connections.</span>{onOpenConnections && <button type="button" className="primary" onClick={onOpenConnections}>Open Connections</button>}</div> : <div className="ide-body"><aside className="ide-files" aria-label="Code files"><div className="ide-files-title">Files</div>{loading && !files.length && <div className="ide-empty">Loading...</div>}{!loading && !files.length && <div className="ide-empty">No code files found.</div>}{renderTree(tree, 0)}</aside><section className="ide-editor" aria-label="Code editor"><div className="ide-editor-head"><span title={selected || undefined}>{(selected ? basename(selected) : "Select a file")}{dirty ? " · unsaved" : ""}</span><button type="button" className="primary" onClick={() => void saveFile()} disabled={!selected || !dirty || !canEdit || saving}>{saving ? "Saving..." : "Save"}</button></div><textarea className="ide-code" value={content} disabled={!selected || loading} onChange={(event) => { setContent(event.target.value); setDirty(true); }} spellCheck={false} aria-label={selected ? `Editing ${selected}` : "Code editor"} placeholder="Choose a code file from the left." />{error && <div className="ide-error">{error}</div>}</section></div>}
      </div>
    </div>
  );
}

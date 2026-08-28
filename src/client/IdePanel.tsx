import { useCallback, useEffect, useMemo, useState } from "react";

import type { FsRequest, FsResponse, WorkspaceInfo } from "../shared/workspace";

const CODE_EXTENSIONS = /\.(c|cc|cpp|css|go|h|hpp|html?|java|js|jsx|json|md|mjs|py|rb|rs|sql|sh|swift|ts|tsx|toml|vue|xml|yaml|yml)$/i;

function filesFromListing(data: string): string[] {
  return data
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("(") && !line.endsWith("/") && CODE_EXTENSIONS.test(line));
}

export function IdePanel({
  workspace,
  canEdit,
  onRequest,
  onClose,
}: {
  workspace: WorkspaceInfo;
  canEdit: boolean;
  onRequest: (req: FsRequest) => Promise<FsResponse>;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await onRequest({ op: "list", path: "", depth: 4, deny: [] });
    if (!response.ok) setError(response.error);
    else setFiles(filesFromListing(response.data));
    setLoading(false);
  }, [onRequest]);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

  const openFile = useCallback(async (path: string) => {
    setSelected(path);
    setLoading(true);
    setError(null);
    const response = await onRequest({ op: "read", path, offset: 0, limit: 64_000 });
    if (!response.ok) {
      setError(response.error);
      setContent("");
    } else {
      setContent(response.data);
      setDirty(false);
    }
    setLoading(false);
  }, [onRequest]);

  const saveFile = useCallback(async () => {
    if (!selected || !canEdit) return;
    setSaving(true);
    setError(null);
    const response = await onRequest({ op: "write", path: selected, content, deny: [] });
    if (!response.ok) setError(response.error);
    else { setDirty(false); await loadFiles(); }
    setSaving(false);
  }, [canEdit, content, loadFiles, onRequest, selected]);

  const createFile = useCallback(async () => {
    const path = newPath.trim();
    if (!path || !canEdit) return;
    setSaving(true);
    setError(null);
    const response = await onRequest({ op: "write", path, content: "", deny: [] });
    if (!response.ok) setError(response.error);
    else { setNewPath(""); await loadFiles(); await openFile(path); }
    setSaving(false);
  }, [canEdit, loadFiles, newPath, onRequest, openFile]);

  const status = useMemo(() => {
    if (workspace.kind === "none") return "Connect a workspace to begin.";
    if (!workspace.online) return "The workspace host is offline.";
    return canEdit ? "Changes save to the connected workspace." : "Read-only access for this member.";
  }, [canEdit, workspace.kind, workspace.online]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal ide-modal" role="dialog" aria-label="Code workspace" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div><h2>Code workspace</h2><p className="ide-status">{status}</p></div>
          <button className="icon" onClick={onClose} aria-label="Close code workspace">✕</button>
        </header>
        <div className="ide-toolbar">
          <button type="button" onClick={() => void loadFiles()} disabled={loading}>Refresh</button>
          {canEdit && (
            <form onSubmit={(event) => { event.preventDefault(); void createFile(); }} className="ide-new-file">
              <input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="src/new-file.ts" aria-label="New file path" />
              <button type="submit" disabled={!newPath.trim() || saving}>New file</button>
            </form>
          )}
        </div>
        <div className="ide-body">
          <aside className="ide-files" aria-label="Code files">
            <div className="ide-files-title">Files</div>
            {loading && !files.length && <div className="ide-empty">Loading...</div>}
            {!loading && !files.length && <div className="ide-empty">No code files found.</div>}
            {files.map((path) => (
              <button type="button" key={path} className={`ide-file ${selected === path ? "ide-file-selected" : ""}`} onClick={() => void openFile(path)}>{path}</button>
            ))}
          </aside>
          <section className="ide-editor" aria-label="Code editor">
            <div className="ide-editor-head">
              <span>{selected || "Select a file"}{dirty ? " · unsaved" : ""}</span>
              <button type="button" className="primary" onClick={() => void saveFile()} disabled={!selected || !dirty || !canEdit || saving}>{saving ? "Saving..." : "Save"}</button>
            </div>
            <textarea className="ide-code" value={content} disabled={!selected || loading} onChange={(event) => { setContent(event.target.value); setDirty(true); }} spellCheck={false} aria-label={selected ? `Editing ${selected}` : "Code editor"} placeholder="Choose a code file from the left." />
            {error && <div className="ide-error">{error}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

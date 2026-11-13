const API_ENDPOINT = "https://6vkpjuest4.execute-api.eu-north-1.amazonaws.com/default/secure-upload-auth";

export const MAX_FILE_MB = 500;

export function validName(name) {
  const n = name.trim();
  if (!n) return "Name cannot be empty.";
  if (n.length > 100) return "Name is too long.";
  if (/[\\/:*?"<>|]/.test(n)) return 'Name cannot contain \\ / : * ? " < > |';
  if (n.startsWith(".")) return "Name cannot start with a dot.";
  return null;
}

async function call(payload) {
  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// -> { tree, updated, truncated, pendingFolders: ["a/b", ...] }
export const getTree = () => call({ action: "tree" });

export const createFolder = (path, name) =>
  call({ action: "createFolder", path: [...path, name] });

// Gets a presigned URL, then PUTs the file straight to S3 with progress.
export async function uploadFile(path, file, onProgress) {
  const contentType = file.type || "application/octet-stream";
  const { uploadUrl } = await call({
    action: "presign",
    path,
    fileName: file.name,
    fileType: contentType,
    fileSize: file.size,
  });

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

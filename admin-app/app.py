import os
import re
import json
import base64
import hashlib
import boto3
from datetime import datetime, timezone
import streamlit as st

# Load Configuration
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")
if os.path.exists(CONFIG_PATH):
    with open(CONFIG_PATH, "r") as f:
        config = json.load(f)
else:
    config = {
        "aws_bucket_name": "your-s3-bucket-name",
        "aws_region": "eu-north-1",
        "ssd_destination_dir": "./ApprovedSubmissions"
    }

BUCKET_NAME = config["aws_bucket_name"]
REGION = config["aws_region"]
SSD_DIR = config["ssd_destination_dir"]

TREE_KEY = "published/tree.json"
FOLDER_PREFIX = "pending-folders/"
MAX_TREE_NODES = 20000
BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

st.set_page_config(page_title="Admin File Approval Dashboard", layout="wide")


@st.cache_resource
def get_s3_client():
    return boto3.client('s3', region_name=REGION)


s3 = get_s3_client()


# ---------- helpers ----------
def verify_ssd_path():
    if not os.path.exists(SSD_DIR):
        try:
            os.makedirs(SSD_DIR, exist_ok=True)
            return True
        except Exception:
            return False
    return os.access(SSD_DIR, os.W_OK)


def valid_segment(s):
    return (bool(s) and s == s.strip() and len(s) <= 200 and not BAD_CHARS.search(s)
            and s not in (".", "..") and not s.startswith("."))


def b64d(token):
    token += "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(token.encode()).decode()


def decode_parts(token):
    """'~' = SSD root, otherwise base64url of 'a/b/c'. Raises on invalid input."""
    if token == "~":
        return []
    parts = b64d(token).split("/")
    if not all(valid_segment(p) for p in parts):
        raise ValueError("invalid path")
    return parts


def parse_key(key):
    """uploads/<unique>/<folder-token>/<filename>  (legacy: uploads/<unique>-<filename>)"""
    parts = key.split("/")
    if len(parts) == 4:
        filename = parts[3]
        try:
            target = decode_parts(parts[2])
        except Exception:
            target = None
    else:
        name = parts[-1]
        filename = name.split("-", 1)[1] if "-" in name else name
        target = []
    return os.path.basename(filename), target


def resolve_target_dir(parts):
    root = os.path.realpath(SSD_DIR)
    target = os.path.realpath(os.path.join(root, *parts))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("Target path escapes the SSD directory")
    return target


def unique_path(directory, filename):
    base, ext = os.path.splitext(filename)
    candidate = os.path.join(directory, filename)
    n = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{base} ({n}){ext}")
        n += 1
    return candidate


# ---------- SSD listing published to S3 ----------
def build_tree(path, counter):
    node = {"name": os.path.basename(path.rstrip(os.sep)) or "SSD", "type": "folder", "children": []}
    try:
        with os.scandir(path) as it:
            entries = sorted(it, key=lambda e: e.name.lower())
    except OSError:
        return node
    for e in entries:
        if e.name.startswith("."):
            continue
        if counter[0] >= MAX_TREE_NODES:
            counter[1] = True
            break
        counter[0] += 1
        try:
            if e.is_dir(follow_symlinks=False):
                node["children"].append(build_tree(e.path, counter))
            elif e.is_file(follow_symlinks=False):
                node["children"].append({"name": e.name, "type": "file", "size": e.stat().st_size})
        except OSError:
            continue
    return node


def sync_listing():
    """Publish the current SSD folder/file listing to S3 (one small JSON file)."""
    try:
        counter = [0, False]
        tree = build_tree(os.path.realpath(SSD_DIR), counter)
        tree["name"] = "SSD"
        payload = {
            "updated": datetime.now(timezone.utc).isoformat(),
            "truncated": counter[1],
            "tree": tree,
        }
        s3.put_object(Bucket=BUCKET_NAME, Key=TREE_KEY,
                      Body=json.dumps(payload).encode(), ContentType="application/json")
        st.session_state["tree_synced_at"] = datetime.now().strftime("%H:%M:%S")
        return True, ""
    except Exception as e:
        return False, str(e)


# ---------- S3 queries ----------
def get_all_submissions():
    submissions = []
    try:
        paginator = s3.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix='uploads/'):
            for obj in page.get('Contents', []):
                key = obj['Key']
                if key == 'uploads/' or key.endswith('/'):
                    continue
                filename, target = parse_key(key)
                submissions.append({
                    "file_key": key,
                    "original_filename": filename,
                    "target_parts": target,
                    "file_size": obj.get('Size', 0),
                    "upload_timestamp": obj.get('LastModified').isoformat() if obj.get('LastModified') else '',
                    "status": "pending"
                })
    except Exception as e:
        st.error(f"Error connecting to AWS S3: {e}")
    return submissions


def get_pending_folders():
    folders = []
    try:
        paginator = s3.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=FOLDER_PREFIX):
            for obj in page.get('Contents', []):
                key = obj['Key']
                if key.endswith('/'):
                    continue
                token = key[len(FOLDER_PREFIX):].removesuffix('.json')
                try:
                    parts = decode_parts(token)
                    if not parts:
                        parts = None
                except Exception:
                    parts = None
                folders.append({"key": key, "parts": parts})
    except Exception as e:
        st.error(f"Error listing folder requests: {e}")
    return folders


# ---------- UI ----------
st.title("🗄️ Local Administrator Approval Dashboard")
st.markdown("Manage remote submissions, review file details, and securely transfer approved files directly to your external SSD.")

flash = st.session_state.pop("flash", None)
if flash:
    getattr(st, flash[0])(flash[1])

st.sidebar.header("System Status")
ssd_ready = verify_ssd_path()
if ssd_ready:
    st.sidebar.success(f"✅ SSD Connected & Writable:\n`{SSD_DIR}`")
    if not st.session_state.get("tree_synced"):
        ok, err = sync_listing()
        st.session_state["tree_synced"] = ok
        if not ok:
            st.sidebar.error(f"Could not publish SSD listing: {err}")
else:
    st.sidebar.error(f"❌ SSD Not Connected or Writable:\n`{SSD_DIR}`")

if st.sidebar.button("🔄 Refresh Submissions"):
    st.rerun()

if st.sidebar.button("📂 Sync SSD listing", disabled=not ssd_ready):
    ok, err = sync_listing()
    if ok:
        st.sidebar.success("SSD listing published to the website.")
    else:
        st.sidebar.error(f"Sync failed: {err}")

submissions = get_all_submissions()
pending_list = [s for s in submissions if s.get('status') == 'pending']
pending_folders = get_pending_folders()

col1, col2, col3 = st.columns(3)
col1.metric("Pending Files", len(pending_list))
col2.metric("Pending Folders", len(pending_folders))
col3.metric("Listing last synced", st.session_state.get("tree_synced_at", "—"))

st.markdown("---")

# ----- Folder requests -----
st.header("Pending Folder Requests")
if not pending_folders:
    st.info("No pending folder requests.")

for fo in pending_folders:
    label = "/".join(fo["parts"]) if fo["parts"] else f"(invalid request: {fo['key']})"
    with st.container(border=True):
        c1, c2, c3 = st.columns([4, 1, 1])
        c1.write(f"📁 **SSD/{label}**" if fo["parts"] else f"⚠️ {label}")
        if c2.button("✅ Create", key=f"fapp_{fo['key']}", disabled=not ssd_ready or fo["parts"] is None):
            try:
                os.makedirs(resolve_target_dir(fo["parts"]), exist_ok=True)
                s3.delete_object(Bucket=BUCKET_NAME, Key=fo["key"])
                sync_listing()
                st.session_state["flash"] = ("success", f"Folder created: {label}")
                st.rerun()
            except Exception as e:
                st.error(f"Could not create folder: {e}")
        if c3.button("❌ Reject", key=f"frej_{fo['key']}"):
            try:
                s3.delete_object(Bucket=BUCKET_NAME, Key=fo["key"])
                st.session_state["flash"] = ("warning", f"Folder request rejected: {label}")
                st.rerun()
            except Exception as e:
                st.error(f"Error rejecting request: {e}")

st.markdown("---")

# ----- File approvals -----
st.header("Pending Approval Queue")
if not pending_list:
    st.info("No pending submissions found in S3.")

for sub in pending_list:
    file_key = sub['file_key']
    target = sub['target_parts']
    target_label = "SSD/" + "/".join(target) if target else ("SSD (root)" if target == [] else "INVALID")
    with st.expander(f"File: {sub['original_filename']} ({sub['file_size'] / (1024*1024):.2f} MB) → {target_label}"):
        c1, c2 = st.columns(2)
        with c1:
            st.write(f"**Filename:** {sub['original_filename']}")
            st.write(f"**File Size:** {sub['file_size'] / (1024*1024):.2f} MB")
            st.write(f"**Target folder:** {target_label}")
        with c2:
            st.write(f"**Upload Timestamp:** {sub['upload_timestamp']}")
            st.write(f"**S3 Key:** `{file_key}`")

        col_app, col_rej = st.columns(2)

        with col_app:
            if st.button("✅ APPROVE & TRANSFER", key=f"app_{file_key}",
                         disabled=not ssd_ready or target is None):
                with st.spinner("Downloading file from S3 to SSD..."):
                    local_file_path = None
                    try:
                        target_dir = resolve_target_dir(target)
                        os.makedirs(target_dir, exist_ok=True)
                        local_file_path = unique_path(target_dir, sub['original_filename'])

                        # 1. Download file directly from S3 to SSD
                        s3.download_file(BUCKET_NAME, file_key, local_file_path)

                        # 2. SHA256 checksum
                        sha256_hash = hashlib.sha256()
                        with open(local_file_path, "rb") as f:
                            for byte_block in iter(lambda: f.read(1024 * 1024), b""):
                                sha256_hash.update(byte_block)
                        checksum = sha256_hash.hexdigest()

                        # 3. Verify size matches S3 before deleting the S3 copy
                        if (os.path.exists(local_file_path)
                                and os.path.getsize(local_file_path) > 0
                                and os.path.getsize(local_file_path) == sub['file_size']):
                            s3.delete_object(Bucket=BUCKET_NAME, Key=file_key)
                            sync_listing()
                            st.session_state["flash"] = (
                                "success",
                                f"Transferred to {target_label}, verified (SHA256: {checksum[:12]}...), S3 copy removed."
                            )
                            st.rerun()
                        else:
                            if local_file_path and os.path.exists(local_file_path):
                                os.remove(local_file_path)
                            st.error("Verification failed: downloaded file is missing, empty or has the wrong size. S3 copy kept.")
                    except Exception as e:
                        st.error(f"Transfer failed: {str(e)}")

        with col_rej:
            if st.button("❌ REJECT", key=f"rej_{file_key}"):
                try:
                    s3.delete_object(Bucket=BUCKET_NAME, Key=file_key)
                    st.session_state["flash"] = ("warning", f"File {sub['original_filename']} rejected and removed from S3.")
                    st.rerun()
                except Exception as e:
                    st.error(f"Error rejecting file: {e}")
import base64
import json
import os
import re
import uuid
from datetime import datetime, timezone

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET_NAME = os.environ.get('BUCKET_NAME', 'local-cloud-queue-856805821816-eu-north-1-an')
BUCKET_REGION = os.environ.get('BUCKET_REGION', 'eu-north-1')
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')  # set to https://your-site.netlify.app

TREE_KEY = 'published/tree.json'
FOLDER_PREFIX = 'pending-folders/'
UPLOAD_PREFIX = 'uploads/'
MAX_FILE_BYTES = 500 * 1024 * 1024
MAX_PENDING_FILES = 1000
BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

s3 = boto3.client(
    's3',
    region_name=BUCKET_REGION,
    config=Config(signature_version='s3v4', s3={'addressing_style': 'virtual'}),
)

CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'OPTIONS,POST',
    'Content-Type': 'application/json',
}


def respond(status, body):
    return {'statusCode': status, 'headers': CORS_HEADERS, 'body': json.dumps(body)}


# ---------- validation / tokens (must match app.py) ----------
def clean_name(name, limit=100):
    if not isinstance(name, str):
        raise ValueError('Invalid name')
    name = name.strip()
    if (not name or len(name) > limit or BAD_CHARS.search(name)
            or name in ('.', '..') or name.startswith('.')):
        raise ValueError(f'Invalid name: {name[:40]!r}')
    return name


def clean_path(parts):
    if not isinstance(parts, list) or len(parts) > 12:
        raise ValueError('Invalid path')
    return [clean_name(p) for p in parts]


def encode_token(parts):
    """'~' = SSD root, else base64url of 'a/b/c' (app.py decodes this)."""
    if not parts:
        return '~'
    return base64.urlsafe_b64encode('/'.join(parts).encode()).decode().rstrip('=')


def decode_token(token):
    if token == '~':
        return []
    token += '=' * (-len(token) % 4)
    parts = base64.urlsafe_b64decode(token.encode()).decode().split('/')
    return clean_path(parts)


def get_path(body):
    """Accepts path as a list (frontend) or folderPath as 'a/b' (legacy)."""
    path = body.get('path')
    if path is None:
        path = [p for p in (body.get('folderPath') or '').split('/') if p]
    return clean_path(path)


# ---------- actions ----------
def action_tree(body):
    tree, updated, truncated = None, None, False
    try:
        obj = s3.get_object(Bucket=BUCKET_NAME, Key=TREE_KEY)
        data = json.loads(obj['Body'].read())
        tree = data.get('tree')
        updated = data.get('updated')
        truncated = bool(data.get('truncated'))
    except ClientError as e:
        if e.response['Error']['Code'] not in ('NoSuchKey', '404'):
            raise

    pending_folders = []
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=FOLDER_PREFIX):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if key.endswith('/'):
                continue
            token = key[len(FOLDER_PREFIX):]
            if token.endswith('.json'):
                token = token[:-5]
            try:
                parts = decode_token(token)
            except Exception:
                continue
            if parts:
                pending_folders.append('/'.join(parts))

    pending_files = []
    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=UPLOAD_PREFIX):
        for obj in page.get('Contents', []):
            key = obj['Key']
            segs = key.split('/')
            if len(segs) != 4 or not segs[3]:
                continue
            try:
                parts = decode_token(segs[2])
            except Exception:
                continue
            pending_files.append({'path': parts, 'name': segs[3], 'size': obj.get('Size', 0)})
            if len(pending_files) >= MAX_PENDING_FILES:
                break
        if len(pending_files) >= MAX_PENDING_FILES:
            break

    return respond(200, {
        'tree': tree,
        'updated': updated,
        'truncated': truncated,
        'pendingFolders': pending_folders,
        'pendingFiles': pending_files,
    })


def action_presign(body):
    path = get_path(body)
    filename = clean_name(body.get('fileName') or body.get('filename') or 'uploaded-file', 200)
    content_type = body.get('fileType') or body.get('content_type') or 'application/octet-stream'
    size = int(body.get('fileSize') or 0)
    if size > MAX_FILE_BYTES:
        raise ValueError('File is too large (max 500 MB)')

    unique = f"{int(datetime.now(timezone.utc).timestamp())}_{uuid.uuid4().hex[:6]}"
    file_key = f"{UPLOAD_PREFIX}{unique}/{encode_token(path)}/{filename}"

    url = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': BUCKET_NAME, 'Key': file_key, 'ContentType': content_type},
        ExpiresIn=300,
    )
    return respond(200, {'uploadUrl': url, 'file_key': file_key})


def action_create_folder(body):
    path = get_path(body)
    if not path:
        raise ValueError('Folder name required')
    key = f"{FOLDER_PREFIX}{encode_token(path)}.json"
    s3.put_object(Bucket=BUCKET_NAME, Key=key, Body=b'{}', ContentType='application/json')
    return respond(200, {'ok': True})


def lambda_handler(event, context):
    method = (event.get('httpMethod')
              or event.get('requestContext', {}).get('http', {}).get('method'))
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    try:
        raw = event.get('body') or '{}'
        if event.get('isBase64Encoded'):
            raw = base64.b64decode(raw).decode()
        body = json.loads(raw)
        action = body.get('action', 'tree')

        if action in ('tree', 'list_directory'):
            return action_tree(body)
        if action in ('presign', 'upload_url'):
            return action_presign(body)
        if action in ('createFolder', 'create_folder'):
            return action_create_folder(body)
        return respond(400, {'error': f'Unknown action: {action}'})
    except ValueError as e:
        return respond(400, {'error': str(e)})
    except Exception as e:
        print('Unhandled error:', repr(e))
        return respond(500, {'error': 'Internal error'})
#!/home/murtaza/.local/share/pipx/venvs/hermes-agent/bin/python3
"""WhatsApp CRM bot -> Google Drive uploader / downloader.

Bot reposunda, versiyon kontrollu, kendi basina calisir. ~/.hermes dispatch
koduna BAGIMLI DEGILDIR; yalnizca paylasilan Drive token dosyasini kullanir
(token = stabil config, kod = repo icinde).

Auth   : BOT_DRIVE_TOKEN_PATH (default ~/.hermes/drive_token.json), scope drive.
Klasor : BOT_CUSTOMERS_DIR/<slug>.md kartindaki Drive folder ID'leri label'a gore
         kategorize edilir; oncelik dispatch parser'i ile ayni:
         drive_root -> drive_assets -> drive_shared -> drive_gallery -> ilk folder.
Yol    : <firma_root>/WhatsApp/<Tur>/  (Tur: Görseller/Videolar/Belgeler/Ses)
Inbox  : firma bagli degilse <Work veya My Drive>/MURTAZA/WhatsApp/Gelen-Kutusu/
         <gonderen>/<Tur>/  (upload-inbox komutu).

Cikti  : her zaman tek satir JSON (stdout). Hata da JSON:
         {"status":"error","error": "..."} ve exit code 1.

CLI:
    wa_drive_upload.py resolve      --slug <slug>
    wa_drive_upload.py upload       --slug <slug> --kind <image|video|audio|document|sticker> --file <path> [--name <name>]
    wa_drive_upload.py upload-inbox --sender <gonderen> --kind <...> --file <path> [--name <name>]
    wa_drive_upload.py download     --id <fileId> --out <path>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive"]
FOLDER_MIME = "application/vnd.google-apps.folder"
FOLDER_ID_RE = re.compile(r"folders/([A-Za-z0-9_-]{15,})")
# Bold label at line start: "- **Label:**" (dispatch parser ile aynı regex).
LABEL_RE = re.compile(r"\*\*([^*]+?)\*\*")

# Medya turu -> firma klasoru icindeki Turkce alt klasor adi.
KIND_FOLDER = {
    "image": "Görseller",
    "sticker": "Görseller",
    "video": "Videolar",
    "audio": "Ses",
    "document": "Belgeler",
}


def token_path() -> Path:
    raw = os.environ.get("BOT_DRIVE_TOKEN_PATH") or str(Path.home() / ".hermes" / "drive_token.json")
    return Path(raw).expanduser()


def customers_dir() -> Path:
    env = os.environ.get("BOT_CUSTOMERS_DIR")
    if env:
        return Path(env).expanduser()
    # default: vault 01-Musteriler (… / MURTAZA / 04-Projeler / <bot> / scripts / bu dosya)
    return Path(__file__).resolve().parents[3] / "01-Musteriler"


def get_service():
    """Drive v3 servisi; suresi gecmis token'i sessizce yeniler (atomic + 0600)."""
    tp = token_path()
    if not tp.exists():
        raise RuntimeError("Drive token bulunamadi")
    creds = Credentials.from_authorized_user_file(str(tp), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        tmp = tp.with_suffix(".json.tmp")
        tmp.write_text(creds.to_json())
        os.chmod(tmp, 0o600)
        os.replace(tmp, tp)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def resolve_root(slug: str) -> str | None:
    """slug -> firma Drive kök klasör ID.

    Önceliği dispatch parser'ından (orchestrator/customer_card_parser.py
    primary_scan_root) birebir taklit eder: kartı satır satır gez, her satırdaki
    bold label'a göre folder id'leri kategorize et, sonra
    drive_root → drive_assets → drive_shared → drive_gallery → ilk folder
    sırasıyla ilk dolu olanı dön. (Eski "ilk root geçen satır" mantığı kırılgandı:
    Lavanda için dispatch'ten farklı id dönüyordu.)
    """
    safe = re.sub(r"[^a-z0-9_-]", "", slug.strip().lower())
    if not safe:
        return None
    card = customers_dir() / f"{safe}.md"
    if not card.exists():
        return None
    text = card.read_text(encoding="utf-8", errors="replace")

    drive_root = None
    drive_assets = None
    drive_shared = None
    drive_gallery = None
    first_folder = None

    for line in text.splitlines():
        ids = FOLDER_ID_RE.findall(line)
        if not ids:
            continue
        m = LABEL_RE.search(line)
        label = (m.group(1) if m else "").lower()
        for fid in ids:
            if first_folder is None:
                first_folder = fid
            if not label:
                continue
            # ESMARK internal customer root — "X root" ama generic arşiv/murtaza değil.
            if "root" in label and "arsiv" not in label and "arşiv" not in label and "murtaza" not in label and drive_root is None:
                drive_root = fid
            if ("asset" in label or "logo" in label) and drive_assets is None:
                drive_assets = fid
            if ("shared" in label or "paylaşım" in label or "paylasim" in label) and drive_shared is None:
                drive_shared = fid
            if ("galeri" in label or "gallery" in label) and drive_gallery is None:
                drive_gallery = fid

    return drive_root or drive_assets or drive_shared or drive_gallery or first_folder


def find_folder(svc, parent_id: str, name: str) -> str | None:
    # Once backslash, sonra tek tirnak escape edilir; aksi halde icindeki '\' kacisi bozar.
    safe = name.replace("\\", "\\\\").replace("'", "\\'")
    q = f"name='{safe}' and '{parent_id}' in parents and mimeType='{FOLDER_MIME}' and trashed=false"
    # orderBy=createdTime: ayni isimli klasor birden fazla varsa (yaris/duplicate) HER ZAMAN
    # en eski olusturulani sec. Boylece sonraki cagrilar tutarli ayni klasoru bulur, medya dagilmaz.
    r = svc.files().list(q=q, fields="files(id)", orderBy="createdTime", pageSize=1).execute()
    fs = r.get("files", [])
    return fs[0]["id"] if fs else None


def ensure_folder(svc, parent_id: str, name: str) -> str:
    existing = find_folder(svc, parent_id, name)
    if existing:
        return existing
    body = {"name": name, "mimeType": FOLDER_MIME, "parents": [parent_id]}
    return svc.files().create(body=body, fields="id").execute()["id"]


def ensure_path(svc, root_id: str, parts: list[str]) -> str:
    parent = root_id
    for seg in parts:
        if seg:
            parent = ensure_folder(svc, parent, seg)
    return parent


def file_exists(svc, parent_id: str, name: str, size: int) -> str | None:
    """Idempotency: ayni klasorde ayni ad+boyut dosya varsa ID'sini dondur."""
    # Once backslash, sonra tek tirnak escape edilir; aksi halde icindeki '\' kacisi bozar.
    safe = name.replace("\\", "\\\\").replace("'", "\\'")
    q = f"name='{safe}' and '{parent_id}' in parents and mimeType!='{FOLDER_MIME}' and trashed=false"
    r = svc.files().list(q=q, fields="files(id,size)", pageSize=10).execute()
    for f in r.get("files", []):
        try:
            if int(f.get("size", 0)) == size:
                return f["id"]
        except (ValueError, TypeError):
            continue
    return None


def cmd_resolve(args) -> dict:
    root = resolve_root(args.slug)
    if not root:
        return {"status": "error", "error": f"'{args.slug}' icin Drive root bulunamadi"}
    return {"status": "ok", "slug": args.slug, "root_id": root}


def upload_to_target(svc, target: str, file_path: Path, name: str) -> dict:
    """Idempotent yukleme: ayni ad+boyut varsa skip, yoksa create. Tek satir JSON dondurur."""
    size = file_path.stat().st_size
    existing = file_exists(svc, target, name, size)
    if existing:
        link = svc.files().get(fileId=existing, fields="webViewLink").execute().get("webViewLink")
        return {"status": "skip", "drive_id": existing, "link": link, "folder_id": target}
    media = MediaFileUpload(str(file_path), resumable=True, chunksize=8 * 1024 * 1024)
    f = svc.files().create(
        body={"name": name, "parents": [target]}, media_body=media, fields="id,webViewLink"
    ).execute()
    return {"status": "uploaded", "drive_id": f.get("id"), "link": f.get("webViewLink"), "folder_id": target}


def cmd_upload(args) -> dict:
    p = Path(args.file)
    if not p.exists():
        return {"status": "error", "error": "dosya yok", "file": str(p)}
    root = resolve_root(args.slug)
    if not root:
        return {"status": "error", "error": f"'{args.slug}' icin Drive root bulunamadi"}
    folder_name = KIND_FOLDER.get(args.kind, "Diger")
    svc = get_service()
    target = ensure_path(svc, root, ["WhatsApp", folder_name])
    name = (args.name or "").strip() or p.name
    return upload_to_target(svc, target, p, name)


# Atanmamis (firma karti bagli olmayan) gelen medya icin fallback kok klasor.
# Kullanici Drive'inda "Work" varsa onun altinda, yoksa My Drive kokunde "MURTAZA"
# klasoru ensure edilir; medya MURTAZA/WhatsApp/Gelen-Kutusu/<gonderen>/<Tur>/ altina gider.
INBOX_NS = "MURTAZA"
INBOX_PATH = ["WhatsApp", "Gelen-Kutusu"]


def inbox_root(svc) -> str:
    work = find_folder(svc, "root", "Work") or find_folder(svc, "root", "WORK")
    parent = work or "root"
    return ensure_folder(svc, parent, INBOX_NS)


def safe_sender(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_-]", "", (value or "").strip())[:40]
    return cleaned or "bilinmeyen"


def cmd_upload_inbox(args) -> dict:
    p = Path(args.file)
    if not p.exists():
        return {"status": "error", "error": "dosya yok", "file": str(p)}
    folder_name = KIND_FOLDER.get(args.kind, "Diger")
    svc = get_service()
    root = inbox_root(svc)
    sender = safe_sender(args.sender)
    target = ensure_path(svc, root, INBOX_PATH + [sender, folder_name])
    name = (args.name or "").strip() or p.name
    return upload_to_target(svc, target, p, name)


def cmd_download(args) -> dict:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    svc = get_service()
    meta = svc.files().get(fileId=args.id, fields="name,mimeType").execute()
    req = svc.files().get_media(fileId=args.id)
    with open(out, "wb") as fh:
        dl = MediaIoBaseDownload(fh, req, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            _, done = dl.next_chunk()
    return {"status": "ok", "path": str(out), "name": meta.get("name"), "mime": meta.get("mimeType")}


def main() -> None:
    ap = argparse.ArgumentParser(description="WhatsApp CRM -> Drive uploader")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve")
    r.add_argument("--slug", required=True)
    u = sub.add_parser("upload")
    u.add_argument("--slug", required=True)
    u.add_argument("--kind", required=True)
    u.add_argument("--file", required=True)
    u.add_argument("--name", default="")
    ui = sub.add_parser("upload-inbox")
    ui.add_argument("--sender", required=True)
    ui.add_argument("--kind", required=True)
    ui.add_argument("--file", required=True)
    ui.add_argument("--name", default="")
    d = sub.add_parser("download")
    d.add_argument("--id", required=True)
    d.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        if args.cmd == "resolve":
            out = cmd_resolve(args)
        elif args.cmd == "upload":
            out = cmd_upload(args)
        elif args.cmd == "upload-inbox":
            out = cmd_upload_inbox(args)
        elif args.cmd == "download":
            out = cmd_download(args)
        else:
            out = {"status": "error", "error": "bilinmeyen komut"}
    except HttpError as e:
        out = {"status": "error", "error": f"drive_api: {str(e)[:200]}"}
    except Exception as e:  # noqa: BLE001 — CLI sınırı, hata JSON olarak döner
        out = {"status": "error", "error": f"{type(e).__name__}: {str(e)[:200]}"}

    print(json.dumps(out, ensure_ascii=False))
    if out.get("status") == "error":
        sys.exit(1)


if __name__ == "__main__":
    main()

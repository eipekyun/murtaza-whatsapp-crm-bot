#!/usr/bin/env python3
"""Perfex READ-ONLY query bridge for the MURTAZA WhatsApp CRM bot.

Runs SELECT-only queries against Perfex (open tasks + projects for one client) over
SSH+mysql and prints a single-line JSON envelope to stdout. The bot's PerfexReader
spawns this script and parses that line.

Read-only guarantees:
  - Issues SELECT statements only. Never INSERT/UPDATE/DELETE.
  - client id is int-cast before interpolation (SQL injection guard).
  - On any failure prints {"tasks":[],"projects":[],"error":"..."} and exits 0 so
    the bot can parse the envelope instead of crashing on a non-zero exit.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shlex
import subprocess
import sys
from typing import Optional

DEFAULT_OPS_ENV = "~/.config/murtaza-vps-ops.env"

# task status (tbltasks.status): 1=Başlamadı, 2=Devam, 3=Test, 4=Geri Bildirim, 5=Tamamlandı
STATUS_LABELS = {
    1: "Başlamadı",
    2: "Devam Ediyor",
    3: "Test",
    4: "Geri Bildirim",
    5: "Tamamlandı",
}

# project status (tblprojects.status) AYRI bir kod kümesi — görev status'undan farklıdır.
# 1=Başlamadı, 2=Devam Ediyor, 3=Beklemede, 4=Tamamlandı, 5=İptal.
PROJECT_STATUS_LABELS = {
    1: "Başlamadı",
    2: "Devam Ediyor",
    3: "Beklemede",
    4: "Tamamlandı",
    5: "İptal",
}


class QueryError(Exception):
    """Raised when the Perfex bridge cannot return data; surfaced as the JSON error field."""


def load_ops_env(path: pathlib.Path) -> None:
    """Materialize MURTAZA_* vars from an ops env file when not already set."""
    if not path.exists():
        return
    for raw in path.read_text(errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        try:
            tokens = shlex.split(line, posix=True)
        except ValueError:
            continue
        for token in tokens:
            if "=" not in token:
                continue
            key, value = token.split("=", 1)
            if key.startswith("MURTAZA_") and key not in os.environ:
                os.environ[key] = value


def creds_json(env_name: str) -> dict:
    raw = os.environ.get(env_name, "")
    if not raw:
        raise QueryError(f"{env_name} ops-env'de bulunamadı")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise QueryError(f"{env_name} JSON parse edilemedi: {exc}") from exc


def perfex_select(sql: str) -> str:
    """Run a single SELECT via SSH+mysql and return tab-separated, header-less rows."""
    ssh_creds = creds_json("MURTAZA_PERFEX_SSH_JSON")
    mysql_creds = creds_json("MURTAZA_PERFEX_MYSQL_JSON")

    ssh_key = ssh_creds.get("key_path") or ssh_creds.get("key")
    ssh_port = ssh_creds.get("port")
    ssh_user = ssh_creds.get("user")
    ssh_host = ssh_creds.get("host")
    if not all([ssh_key, ssh_port, ssh_user, ssh_host]):
        raise QueryError("SSH creds eksik (key_path/port/user/host)")

    mysql_user = mysql_creds.get("user")
    mysql_pw = mysql_creds.get("password")
    mysql_db = mysql_creds.get("database") or mysql_creds.get("db")
    if not all([mysql_user, mysql_pw, mysql_db]):
        raise QueryError("MySQL creds eksik (user/password/database)")

    remote = f"{ssh_user}@{ssh_host}"
    remote_cmd = (
        f"MYSQL_PWD={shlex.quote(mysql_pw)} "
        f"mysql -u {shlex.quote(mysql_user)} {shlex.quote(mysql_db)} -B -N -e {shlex.quote(sql)}"
    )
    cmd = [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
        "-i", str(ssh_key), "-p", str(ssh_port), remote, remote_cmd,
    ]
    try:
        # TS PerfexReader execFile timeout'u 20s; Python iç timeout'u altında tut ki
        # zaman aşımında SIGKILL yerine bu graceful zarf JSON'ı emit edilebilsin.
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=18)
    except subprocess.TimeoutExpired as exc:
        raise QueryError("Perfex SSH/MySQL zaman aşımı") from exc
    if proc.returncode != 0:
        # Ham SSH/MySQL hatası DB user/host/port gibi bağlantı kimliğini sızdırabilir;
        # detay yalnız stderr log'una, panele giden JSON error'a generic mesaj.
        err = (proc.stderr or proc.stdout or "").strip()
        print(f"[perfex-query] SSH/MySQL hata: {err[:300]}", file=sys.stderr)
        raise QueryError("Perfex sorgusu başarısız (detay sunucu log'unda)")
    return proc.stdout


def parse_rows(out: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in out.splitlines():
        if line == "":
            continue
        rows.append(line.split("\t"))
    return rows


def to_int(value: str, default: int = 0) -> int:
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def fetch_tasks(client_id: int, project_ids: list[int]) -> list[dict]:
    """Açık görevleri çeker: firmaya doğrudan bağlı (rel_type='client') VE firmanın
    projelerine bağlı (rel_type='project') görevler birlikte.

    Perfex'te açık görevlerin çoğu projeye bağlıdır; eski sorgu yalnız 'client' baktığı
    için projedeki işler '0 görev' görünüyordu. Her göreve projectId etiketi eklenir
    (proje-görevinde rel_id, firma-görevinde 0) ki panel projeye göre gruplayabilsin.
    """
    conds = [f"(rel_type='client' AND rel_id={client_id})"]
    if project_ids:
        ids = ",".join(str(int(pid)) for pid in project_ids)
        conds.append(f"(rel_type='project' AND rel_id IN ({ids}))")
    where = " OR ".join(conds)
    sql = (
        "SELECT id,name,priority,status,IFNULL(duedate,''),rel_type,rel_id "
        f"FROM tbltasks WHERE ({where}) AND status<5 "
        "ORDER BY priority DESC, id DESC LIMIT 80;"
    )
    tasks: list[dict] = []
    for cols in parse_rows(perfex_select(sql)):
        if len(cols) < 7:
            continue
        status = to_int(cols[3])
        due = cols[4].strip()
        rel_type = cols[5].strip()
        project_id = to_int(cols[6]) if rel_type == "project" else 0
        task: dict = {
            "id": to_int(cols[0]),
            "name": cols[1],
            "priority": to_int(cols[2]),
            "status": status,
            "statusLabel": STATUS_LABELS.get(status, "Bilinmiyor"),
            "projectId": project_id,
        }
        if due:
            task["dueDate"] = due
        tasks.append(task)
    return tasks


def fetch_projects(client_id: int) -> list[dict]:
    # tblprojects.clientid bazı kurulumlarda yok; o durumda boş liste döner, hata vermez.
    # Sıralama: açık/devam eden projeler (status<4) üstte, tamamlanan/iptal altta.
    sql = (
        "SELECT id,name,status FROM tblprojects "
        f"WHERE clientid={client_id} ORDER BY status ASC, id DESC LIMIT 30;"
    )
    try:
        out = perfex_select(sql)
    except QueryError:
        return []
    projects: list[dict] = []
    for cols in parse_rows(out):
        if len(cols) < 3:
            continue
        status = to_int(cols[2])
        projects.append({
            "id": to_int(cols[0]),
            "name": cols[1],
            "status": status,
            "statusLabel": PROJECT_STATUS_LABELS.get(status, "Bilinmiyor"),
        })
    return projects


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Perfex READ-ONLY tasks+projects query for one client.")
    p.add_argument("--client-id", type=int, required=True, help="Perfex client (rel_id / clientid)")
    p.add_argument("--ops-env", default=DEFAULT_OPS_ENV, help="ops env file with MURTAZA_PERFEX_* JSON")
    return p


def resolve_ops_env(raw: Optional[str]) -> pathlib.Path:
    return pathlib.Path(os.path.expanduser(raw or DEFAULT_OPS_ENV)).resolve()


def main() -> None:
    args = build_parser().parse_args()
    try:
        client_id = int(args.client_id)  # explicit guard even though argparse already typed it
        load_ops_env(resolve_ops_env(args.ops_env))
        # Projeler önce: id'leri görev sorgusunda rel_type='project' filtresine besler.
        projects = fetch_projects(client_id)
        project_ids = [to_int(p["id"]) for p in projects if to_int(p["id"]) > 0]
        tasks = fetch_tasks(client_id, project_ids)
        emit({"tasks": tasks, "projects": projects, "error": None})
    except QueryError as exc:
        emit({"tasks": [], "projects": [], "error": str(exc)})
    except Exception as exc:  # never crash the bot; envelope carries the error
        emit({"tasks": [], "projects": [], "error": f"beklenmedik hata: {exc}"})


if __name__ == "__main__":
    main()

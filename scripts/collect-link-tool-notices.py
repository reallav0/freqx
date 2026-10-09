"""Collect conservative Deno locked-crate notices without building or running crates.
Python 3.11+, standard library only. Downloads checksum-verified source archives.
"""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'runtime/vendor/link-tools/deno-notices'
LOCK_URL = 'https://raw.githubusercontent.com/denoland/deno/v2.9.7/Cargo.lock'


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'freqx-notice-collector'})
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read()


def collect(package):
    name, version = package['name'], package['version']
    data = fetch(f'https://static.crates.io/crates/{name}/{name}-{version}.crate')
    if hashlib.sha256(data).hexdigest() != package['checksum']:
        raise ValueError(f'Crate checksum mismatch: {name}-{version}')
    directory = DEST / f'{name}-{version}'
    directory.mkdir(parents=True, exist_ok=True)
    notices, license_name = [], ''
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if not member.isfile():
                continue
            parts = member.name.split('/')[1:]
            if not parts or '..' in parts or len(parts) > 6:
                continue
            if parts == ['Cargo.toml']:
                license_name = tomllib.loads(archive.extractfile(member).read().decode())['package'].get('license', '')
            leaf = parts[-1].lower()
            if not leaf.startswith(('license', 'licence', 'copying', 'copyright', 'notice')) or member.size > 2_000_000:
                continue
            safe_name = '__'.join(parts)
            (directory / safe_name).write_bytes(archive.extractfile(member).read())
            notices.append(safe_name)
    return {'name': name, 'version': version, 'license': license_name, 'checksum': package['checksum'],
            'source': f'https://crates.io/crates/{name}/{version}', 'notices': sorted(notices)}


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    lock = fetch(LOCK_URL)
    (DEST.parent / 'DENO-Cargo.lock').write_bytes(lock)
    packages = [p for p in tomllib.loads(lock.decode())['package'] if p.get('source', '').startswith('registry+')]
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
        for record in pool.map(collect, packages):
            records.append(record)
            if len(records) % 100 == 0:
                print(f'Collected {len(records)}/{len(packages)} locked-crate notices', flush=True)
    records.sort(key=lambda p: (p['name'], p['version']))
    (DEST.parent / 'DENO-rust-dependencies.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    with (DEST.parent / 'DENO-THIRD-PARTY-LICENSES.txt').open('w', encoding='utf-8') as out:
        out.write('Deno 2.9.7 - conservative notices from every registry crate in its Cargo.lock\n'
                  'Source URLs, versions, checksums and declared licenses: DENO-rust-dependencies.json.\n'
                  'This includes crates for other targets and development tools.\n\n')
        for record in records:
            out.write('\n' + '=' * 80 + '\n' + record['name'] + ' ' + record['version'] + ' | ' + record['license'] + '\n' + record['source'] + '\n')
            for name in record['notices']:
                text = (DEST / f'{record["name"]}-{record["version"]}' / name).read_bytes().decode('utf-8', errors='replace')
                out.write('\n--- ' + name + ' ---\n' + text + '\n')
    print(f'Done: {len(records)} crates; {sum(not p["notices"] for p in records)} have no packaged license file.', flush=True)


if __name__ == '__main__':
    main()

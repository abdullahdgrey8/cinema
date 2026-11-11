# VERSION: 1.00

"""Search official Ubuntu distribution torrents using the Ubuntu tracker."""

import re
from urllib.parse import quote_from_bytes, unquote_plus, unquote_to_bytes
from urllib.request import urlopen

from helpers import download_file
from novaprinter import prettyPrinter


TRACKER = 'https://torrent.ubuntu.com'
TORRENT_PREFIX = TRACKER + '/file?info_hash='
TRACKER_INDEX = TRACKER + '/tracker_index'
MAX_INDEX_BYTES = 1024 * 1024
# The official tracker generates seven columns per row. The first five are
# hash, torrent name, displayed size, seeders, and downloading peers.
ROW = re.compile(
    r'<tr>\s*<td><code>([0-9a-f]{40})</code></td>\s*'
    r'<td><a\s+[^>]*>([a-z0-9][a-z0-9._+-]{0,199}\.iso)</a></td>\s*'
    r'<td[^>]*>([\d.]+\s*[KMGT]?i?B)</td>\s*'
    r'<td[^>]*>(\d+)</td>\s*<td[^>]*>(\d+)</td>',
    re.IGNORECASE,
)


class cinema_ubuntu:
    name = 'Cinema Ubuntu Torrents'
    url = TRACKER_INDEX
    supported_categories = {'all': 'all', 'software': 'software'}

    def search(self, what, cat='all'):
        if cat not in self.supported_categories:
            return
        words = re.findall(r'\w+', unquote_plus(what).casefold())
        if words and not any('ubuntu' in word or word == 'linux' for word in words):
            return
        try:
            with urlopen(TRACKER_INDEX, timeout=8) as response:
                index = response.read(MAX_INDEX_BYTES + 1)
        except OSError:
            return
        if len(index) > MAX_INDEX_BYTES:
            return

        releases = []
        for info_hash, name, size, seeds, leech in ROW.findall(index.decode('utf-8', 'replace')):
            if not all(word == 'linux' or word in name.casefold() for word in words):
                continue
            releases.append((int(seeds), int(leech), name, size, info_hash))

        for seeds, leech, name, size, info_hash in sorted(releases, reverse=True)[:60]:
            link = TORRENT_PREFIX + quote_from_bytes(bytes.fromhex(info_hash), safe='')
            prettyPrinter({
                'link': link, 'name': name, 'size': size,
                'seeds': seeds, 'leech': leech, 'engine_url': self.url,
                'desc_link': TRACKER_INDEX,
            })

    def download_torrent(self, url):
        if not url.startswith(TORRENT_PREFIX):
            return
        info_hash = unquote_to_bytes(url[len(TORRENT_PREFIX):])
        if len(info_hash) == 20:
            canonical_url = TORRENT_PREFIX + quote_from_bytes(info_hash, safe='')
            print(download_file(canonical_url))

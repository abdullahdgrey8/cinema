# VERSION: 1.00

"""A curated set of openly licensed, web-seeded film torrents."""

import re
from urllib.parse import unquote_plus

from helpers import download_file
from novaprinter import prettyPrinter


# Sizes are the sum of the file lengths in the published torrent descriptors.
# WebTorrent hosts the Blender films under Creative Commons licenses. The
# Internet Archive identifies the Market Street scan as public domain.
FILMS = (
    (
        'Big Buck Bunny (2008)', 'animation comedy blender', 276445467,
        'https://webtorrent.io/torrents/big-buck-bunny.torrent',
        'https://studio.blender.org/projects/big-buck-bunny/',
    ),
    (
        'Sintel (2010)', 'animation fantasy blender', 129302391,
        'https://webtorrent.io/torrents/sintel.torrent',
        'https://studio.blender.org/projects/sintel/',
    ),
    (
        'Tears of Steel (2012)', 'science fiction short blender', 571426507,
        'https://webtorrent.io/torrents/tears-of-steel.torrent',
        'https://studio.blender.org/projects/tears-of-steel/',
    ),
    (
        'Cosmos Laundromat (2015)', 'animation fantasy blender', 220864086,
        'https://webtorrent.io/torrents/cosmos-laundromat.torrent',
        'https://studio.blender.org/projects/cosmos-laundromat/',
    ),
    (
        'A Trip Down Market Street (1906)', 'documentary history silent san francisco', 268136750,
        'https://archive.org/download/167622/167622_archive.torrent',
        'https://archive.org/details/167622',
    ),
)


class cinema_open_films:
    name = 'Cinema Open Films'
    url = 'https://webtorrent.io/free-torrents'
    supported_categories = {'all': 'all', 'movies': 'movies'}

    def search(self, what, cat='all'):
        if cat not in self.supported_categories:
            return
        query = re.findall(r'\w+', unquote_plus(what).casefold())
        for name, keywords, size, link, description in FILMS:
            terms = re.findall(r'\w+', f'{name} {keywords} open films'.casefold())
            if all(word in terms for word in query):
                prettyPrinter({
                    'link': link, 'name': name, 'size': size,
                    'seeds': -1, 'leech': -1, 'engine_url': self.url,
                    'desc_link': description,
                })

    def download_torrent(self, url):
        if any(url == film[3] for film in FILMS):
            print(download_file(url))

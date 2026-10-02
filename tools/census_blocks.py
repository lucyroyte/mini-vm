"""Extracts 2020 Census population and housing units for Brooklyn's census
blocks from the Census Bureau's PL 94-171 redistricting file.

    curl -O https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/New_York/ny2020.pl.zip
    unzip ny2020.pl.zip nygeo2020.pl
    python3 tools/census_blocks.py nygeo2020.pl data/census/brooklyn-blocks-2020.json

Only the geographic header file is needed: it carries POP100 and HU100 for
every geography. Blocks are keyed like PLUTO's bctcb2020 column: borough
code 3, then the 6-digit tract and 4-digit block. Output is
{ "30001001000": [population, housing units], ... }, skipping empty blocks.
"""

import json
import sys

KINGS = '047'


def main(src, dst):
    out, pop, hu = {}, 0, 0
    with open(src, encoding='latin-1') as f:
        for line in f:
            p = line.rstrip('\n').split('|')
            if p[2] != '750' or p[14] != KINGS:  # summary level 750 = block
                continue
            geocode = p[9]  # state(2) county(3) tract(6) block(4)
            people, units = int(p[-7]), int(p[-6])  # POP100, HU100
            pop += people
            hu += units
            if people or units:
                out['3' + geocode[5:]] = [people, units]
    with open(dst, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'{len(out)} blocks, {pop:,} people, {hu:,} housing units')


if __name__ == '__main__':
    main(*sys.argv[1:3])

#!/usr/bin/env python
"""
Builds the avatar's 3D bust from the reference painting (tools/reference2.webp): runs
tools/avatar/build.py with the same arguments (see its header for how the head is made).

The first bust (the painted silhouette inflated by a Poisson solve) is in the git history of this
file; the sculpted head replaced it because the inflated one was a featureless wedge when he turned.

Outputs: src/avatar/bust.bin, bust.json, figure.webp. Checks: python tools/avatar/check.py
Run: python tools/build_avatar.py [--preview] [--out DIR]
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'avatar'))
sys.argv[0] = os.path.join(HERE, 'avatar', 'build.py')
runpy.run_path(sys.argv[0], run_name='__main__')

#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 DEV13_OUTPUT_DIRECTORY" >&2
  exit 2
fi

source_dir=$1
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_dir="$project_dir/LocalCircuits"

for source_file in \
  "$source_dir/observation_js/observation.wasm" \
  "$source_dir/observation_final.zkey" \
  "$source_dir/synthetic-input.json" \
  "$source_dir/public.json"
do
  if [ ! -s "$source_file" ]; then
    echo "Missing DEV-13 artifact: $source_file" >&2
    exit 1
  fi
done

umask 077
mkdir -p "$local_dir"
cp "$source_dir/observation_js/observation.wasm" "$local_dir/observation.wasm"
cp "$source_dir/observation_final.zkey" "$local_dir/observation_final.zkey"
cp "$source_dir/synthetic-input.json" "$local_dir/synthetic-input.json"
cp "$source_dir/public.json" "$local_dir/public.json"
python3 "$project_dir/prepare-mopro-input.py" \
  "$local_dir/synthetic-input.json" "$local_dir/mopro-input.json"
echo "Prepared local Mopro inputs in $local_dir"

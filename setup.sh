#!/usr/bin/env bash
# One-time setup: Node dependencies + a local Python env with PyTorch and PixelSeal.
set -euo pipefail
cd "$(dirname "$0")"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)"; exit 1; }
command -v node >/dev/null || { echo "Node.js 18+ is required"; exit 1; }

npm install

if [ ! -x pyenv/bin/python ]; then
  if command -v conda >/dev/null; then
    # conda-forge still ships current PyTorch for Intel Macs; pip wheels stop at 2.2.
    conda create -y -p ./pyenv -c conda-forge python=3.12 pytorch torchvision
  else
    python3 -m venv pyenv
    pyenv/bin/pip install torch torchvision
  fi
fi

# videoseal pins training-only packages (decord, tensorboard); install it without
# them and add only what inference needs.
SRC="$(mktemp -d)/videoseal"
git clone --depth 1 https://github.com/facebookresearch/videoseal.git "$SRC"
pyenv/bin/pip install --no-deps "$SRC"
# The wheel does not include configs/ (needed for JND attenuation); copy it next to the package.
PKG="$(pyenv/bin/python -c 'import videoseal, os; print(os.path.dirname(videoseal.__file__))')"
rm -rf "$PKG/configs" && cp -R "$SRC/configs" "$PKG/configs"
pyenv/bin/pip install omegaconf einops timm==0.9.16 opencv-python-headless av pandas scipy \
  scikit-image safetensors requests tqdm pytorch_msssim PyWavelets lpips pycocotools calflops transformers pillow

# Download the PixelSeal checkpoint now instead of on first request.
pyenv/bin/python -c "import videoseal; videoseal.load('pixelseal'); print('PixelSeal ready')"
pyenv/bin/python -c "import torch; print('NVIDIA GPU (CUDA) available:', torch.cuda.is_available())"
echo "Done. Start with: npm start"

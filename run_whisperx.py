import typing
import collections
import os
import sys
import warnings
import torch

warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    message=r"(?s).*torchcodec is not installed correctly.*",
)

try:
    from torch.serialization import add_safe_globals
except ImportError:
    add_safe_globals = None

if add_safe_globals is not None:
    from omegaconf.listconfig import ListConfig
    from omegaconf.dictconfig import DictConfig
    from omegaconf.base import ContainerMetadata, Metadata
    from omegaconf.nodes import AnyNode, ValueNode, StringNode, IntegerNode, FloatNode, BooleanNode
    from torch.torch_version import TorchVersion
    from pyannote.audio.core.model import Introspection
    from pyannote.audio.core.task import Specifications, Problem, Resolution

    add_safe_globals([
        # OmegaConf containers
        ListConfig,
        DictConfig,
        ContainerMetadata,
        Metadata,

        # OmegaConf nodes
        AnyNode,
        ValueNode,
        StringNode,
        IntegerNode,
        FloatNode,
        BooleanNode,

        # torch
        TorchVersion,

        # pyannote
        Introspection,
        Specifications,
        Problem,
        Resolution,

        # typing
        typing.Any,

        # builtins
        list,
        dict,
        tuple,
        set,
        int,
        float,
        str,
        bool,

        # collections
        collections.defaultdict,
        collections.OrderedDict,
    ])


def _find_arg(name: str):
    for i in range(1, len(sys.argv)):
        token = sys.argv[i]
        if token == name:
            return i, "separate"
        if token.startswith(name + "="):
            return i, "inline"
    return None, None


def _get_arg(name: str):
    idx, mode = _find_arg(name)
    if idx is None:
        return None
    if mode == "inline":
        return sys.argv[idx].split("=", 1)[1]
    if idx + 1 < len(sys.argv) and not sys.argv[idx + 1].startswith("--"):
        return sys.argv[idx + 1]
    return None


def _set_arg(name: str, value: str):
    idx, mode = _find_arg(name)
    if idx is None:
        sys.argv.extend([name, value])
        return

    if mode == "inline":
        sys.argv[idx] = f"{name}={value}"
        return

    if idx + 1 < len(sys.argv) and not sys.argv[idx + 1].startswith("--"):
        sys.argv[idx + 1] = value
    else:
        sys.argv.insert(idx + 1, value)


if "--hf_token" not in sys.argv and "--hf-token" not in sys.argv:
    hf_token = os.environ.get("HF_TOKEN")
    if hf_token:
        sys.argv.extend(["--hf_token", hf_token])

# WhisperX defaults to CPU+float16 in this setup; choose sane defaults automatically.
device = _get_arg("--device")
if device is None:
    if torch.cuda.is_available():
        _set_arg("--device", "cuda")
        device = "cuda"
    else:
        _set_arg("--device", "cpu")
        device = "cpu"

if isinstance(device, str) and device.lower() == "cpu":
    compute_type = _get_arg("--compute_type")
    if compute_type is None or compute_type.lower() == "float16":
        _set_arg("--compute_type", "int8")

    fp16 = _get_arg("--fp16")
    if fp16 is None or fp16.lower() == "true":
        _set_arg("--fp16", "False")
elif isinstance(device, str) and device.lower().startswith("cuda"):
    compute_type = _get_arg("--compute_type")
    if compute_type is None:
        _set_arg("--compute_type", "float16")

    fp16 = _get_arg("--fp16")
    if fp16 is None:
        _set_arg("--fp16", "True")

from whisperx.__main__ import cli

cli()

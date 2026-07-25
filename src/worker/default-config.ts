// GENERATED FILE — do not edit. Run `pnpm config:build` after changing
// config/lanes.yaml or config/providers.yaml. `pnpm lint` fails if it is stale.
//
// This is the lane table a freshly deployed Worker uses when its KV namespace is
// empty, which is the normal state after a Deploy-to-Cloudflare install. Without
// it the gateway answers 503 until someone runs the CLI — see
// scripts/build-default-config.mjs.
import type { RouterConfig } from './config';

export const DEFAULT_CONFIG: RouterConfig = {
  "version": "bundled",
  "providers": {
    "openrouter": {
      "kind": "openai",
      "base_url": "https://openrouter.ai/api/v1",
      "key_env": "OPENROUTER_API_KEY",
      "trains_on_data": true,
      "multimodal_models": [
        "nvidia/nemotron-nano-12b-v2-vl:free"
      ],
      "limits": {
        "rpm": 20,
        "rpd": 1000
      },
      "model_limits": {
        "poolside/laguna-xs-2.1:free": {
          "rpm": 20,
          "rpd": 1000,
          "ctx": 262144,
          "max_out": 32768
        },
        "poolside/laguna-s-2.1:free": {
          "rpm": 20,
          "rpd": 1000,
          "ctx": 262144,
          "max_out": 32768
        },
        "poolside/laguna-m.1:free": {
          "rpm": 20,
          "rpd": 1000,
          "ctx": 262144,
          "max_out": 32768
        },
        "nvidia/nemotron-nano-12b-v2-vl:free": {
          "rpm": 20,
          "rpd": 1000,
          "ctx": 128000
        },
        "nvidia/nemotron-3-super-120b-a12b:free": {
          "rpm": 20,
          "rpd": 1000,
          "ctx": 262144
        },
        "nvidia/nemotron-3-ultra-550b-a55b:free": {
          "rpm": 20,
          "rpd": 1000,
          "ctx": 1000000,
          "max_out": 65536
        }
      }
    },
    "nvidia": {
      "kind": "openai",
      "base_url": "https://integrate.api.nvidia.com/v1",
      "key_env": "NVIDIA_API_KEY",
      "trains_on_data": false,
      "multimodal_models": [
        "meta/llama-3.2-90b-vision-instruct"
      ],
      "limits": {
        "rpm": 40,
        "rpd": 5000
      },
      "model_limits": {
        "stepfun-ai/step-3.7-flash": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 262144
        },
        "nvidia/llama-3.3-nemotron-super-49b-v1": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 131072
        },
        "poolside/laguna-xs-2.1": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 262144
        },
        "mistralai/mistral-small-4-119b-2603": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 262144
        },
        "mistralai/mistral-medium-3.5-128b": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 262144
        },
        "minimaxai/minimax-m3": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 1000000
        },
        "z-ai/glm-5.2": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 1048576
        },
        "deepseek-ai/deepseek-v4-pro": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 1000000
        },
        "deepseek-ai/deepseek-v4-flash": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 1000000
        },
        "meta/llama-3.2-90b-vision-instruct": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 128000
        },
        "nvidia/nemotron-3-ultra-550b-a55b": {
          "rpm": 40,
          "rpd": 5000,
          "ctx": 262144
        }
      }
    },
    "google": {
      "kind": "gemini",
      "base_url": "https://generativelanguage.googleapis.com/v1beta",
      "key_env": "GOOGLE_AI_KEY",
      "trains_on_data": false,
      "multimodal": true,
      "limits": {
        "rpm": 10,
        "rpd": 500,
        "tpm": 250000
      },
      "default_ctx": 1048576,
      "model_limits": {
        "gemini-3.6-flash": {
          "rpm": 10,
          "rpd": 20,
          "ctx": 1048576,
          "max_out": 65536,
          "tpm": 250000
        },
        "gemini-3.1-pro-preview": {
          "rpm": 0,
          "rpd": 0,
          "ctx": 1048576,
          "max_out": 65536,
          "tpm": 250000
        },
        "gemini-3.5-flash-lite": {
          "rpm": 15,
          "rpd": 1000,
          "ctx": 1048576,
          "max_out": 65536
        },
        "gemini-3.1-flash-lite": {
          "rpm": 15,
          "rpd": 1000,
          "ctx": 1048576,
          "max_out": 65536
        }
      }
    },
    "groq": {
      "kind": "openai",
      "base_url": "https://api.groq.com/openai/v1",
      "key_env": "GROQ_API_KEY",
      "enabled": true,
      "trains_on_data": false,
      "limits": {
        "rpm": 30,
        "rpd": 1000,
        "tpm": 8000
      },
      "model_limits": {
        "openai/gpt-oss-120b": {
          "rpm": 30,
          "rpd": 1000,
          "ctx": 131072,
          "max_out": 65536,
          "tpm": 8000
        },
        "openai/gpt-oss-20b": {
          "rpm": 30,
          "rpd": 1000,
          "ctx": 131072,
          "max_out": 65536,
          "tpm": 8000
        },
        "llama-3.1-8b-instant": {
          "rpm": 30,
          "rpd": 14400,
          "ctx": 131072,
          "max_out": 32768,
          "tpm": 6000
        },
        "llama-3.3-70b-versatile": {
          "rpm": 30,
          "rpd": 1000,
          "ctx": 131072,
          "max_out": 32768,
          "tpm": 8000
        }
      }
    },
    "mistral": {
      "kind": "openai",
      "base_url": "https://api.mistral.ai/v1",
      "key_env": "MISTRAL_API_KEY",
      "trains_on_data": true,
      "limits": {
        "rpm": 30,
        "rpd": 5000
      },
      "model_limits": {
        "mistral-small-latest": {
          "rpm": 30,
          "rpd": 5000,
          "ctx": 262144
        },
        "codestral-2508": {
          "rpm": 30,
          "rpd": 5000,
          "ctx": 128000
        },
        "devstral-medium-latest": {
          "rpm": 30,
          "rpd": 5000,
          "ctx": 128000
        }
      }
    },
    "github": {
      "kind": "openai",
      "base_url": "https://models.github.ai/inference",
      "key_env": "GITHUB_MODELS_KEY",
      "trains_on_data": false,
      "limits": {
        "rpm": 5,
        "rpd": 50
      },
      "discovery_url": "https://models.github.ai/catalog/models",
      "model_limits": {
        "openai/gpt-4.1": {
          "rpm": 5,
          "rpd": 50,
          "ctx": 8000,
          "max_out": 4000
        }
      }
    },
    "workersai": {
      "kind": "workers-ai",
      "key_env": "",
      "trains_on_data": false,
      "limits": {
        "rpm": 30,
        "rpd": 300
      },
      "model_limits": {
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
          "rpm": 30,
          "rpd": 300,
          "ctx": 24000
        },
        "@cf/qwen/qwen2.5-coder-32b-instruct": {
          "rpm": 30,
          "rpd": 300,
          "ctx": 32768
        }
      }
    },
    "cfai": {
      "kind": "openai",
      "base_url": "https://api.cloudflare.com/client/v4/accounts/fa8b047b0bd7d52b47a415ee6dbf3fda/ai/v1",
      "key_env": "CF_WORKERS_AI_KEY",
      "trains_on_data": false,
      "limits": {
        "rpm": 30,
        "rpd": 500
      },
      "discovery_url": "https://api.cloudflare.com/client/v4/accounts/fa8b047b0bd7d52b47a415ee6dbf3fda/ai/models/search?per_page=100&task=Text%20Generation",
      "model_limits": {
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
          "rpm": 30,
          "rpd": 500,
          "ctx": 24000
        }
      }
    },
    "sambanova": {
      "kind": "openai",
      "base_url": "https://api.sambanova.ai/v1",
      "key_env": "SAMBANOVA_API_KEY",
      "trains_on_data": false,
      "limits": {
        "rpm": 10,
        "rpd": 500
      },
      "model_limits": {
        "Meta-Llama-3.3-70B-Instruct": {
          "rpm": 10,
          "rpd": 500,
          "ctx": 128000
        },
        "DeepSeek-V3.2": {
          "rpm": 10,
          "rpd": 500,
          "ctx": 32000
        }
      }
    },
    "cohere": {
      "kind": "openai",
      "base_url": "https://api.cohere.ai/compatibility/v1",
      "key_env": "COHERE_API_KEY",
      "trains_on_data": true,
      "limits": {
        "rpm": 10,
        "rpd": 30
      }
    },
    "cerebras": {
      "kind": "openai",
      "base_url": "https://api.cerebras.ai/v1",
      "key_env": "CEREBRAS_API_KEY",
      "enabled": false,
      "trains_on_data": false,
      "limits": {
        "rpm": 30,
        "rpd": 1000
      }
    },
    "hf": {
      "kind": "openai",
      "base_url": "https://router.huggingface.co/v1",
      "key_env": "HF_API_KEY",
      "trains_on_data": true,
      "limits": {
        "rpm": 10,
        "rpd": 500
      },
      "model_limits": {
        "Qwen/Qwen3-Coder-Next": {
          "rpm": 10,
          "rpd": 500,
          "ctx": 262144
        }
      }
    }
  },
  "default_lane": "AGENTIC",
  "allow_paid": false,
  "lanes": {
    "FAST": {
      "spread_top": 1,
      "chain": [
        "groq/openai/gpt-oss-120b",
        "google/gemini-3.5-flash-lite",
        "groq/openai/gpt-oss-20b",
        "groq/llama-3.1-8b-instant",
        "mistral/mistral-small-latest",
        "nvidia/stepfun-ai/step-3.7-flash",
        "cfai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "openrouter/poolside/laguna-xs-2.1:free",
        "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1",
        "workersai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      ]
    },
    "SIMPLE": {
      "spread_top": 2,
      "chain": [
        "openrouter/poolside/laguna-xs-2.1:free",
        "groq/openai/gpt-oss-120b",
        "nvidia/poolside/laguna-xs-2.1",
        "mistral/codestral-2508",
        "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1",
        "nvidia/mistralai/mistral-small-4-119b-2603",
        "sambanova/Meta-Llama-3.3-70B-Instruct",
        "nvidia/mistralai/mistral-medium-3.5-128b",
        "google/gemini-3.5-flash-lite",
        "google/gemini-3.6-flash",
        "openrouter/nvidia/nemotron-nano-12b-v2-vl:free",
        "workersai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      ]
    },
    "AGENTIC": {
      "spread_top": 2,
      "chain": [
        "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        "openrouter/poolside/laguna-xs-2.1:free",
        "nvidia/poolside/laguna-xs-2.1",
        "mistral/devstral-medium-latest",
        "nvidia/minimaxai/minimax-m3",
        "openrouter/poolside/laguna-s-2.1:free",
        "openrouter/poolside/laguna-m.1:free",
        "nvidia/z-ai/glm-5.2",
        "hf/Qwen/Qwen3-Coder-Next",
        "google/gemini-3.6-flash",
        "workersai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      ]
    },
    "HARD": {
      "spread_top": 2,
      "chain": [
        "github/openai/gpt-4.1",
        "nvidia/minimaxai/minimax-m3",
        "sambanova/DeepSeek-V3.2",
        "nvidia/deepseek-ai/deepseek-v4-flash",
        "openrouter/poolside/laguna-s-2.1:free",
        "google/gemini-3.6-flash",
        "nvidia/meta/llama-3.2-90b-vision-instruct",
        "nvidia/deepseek-ai/deepseek-v4-pro",
        "google/gemini-3.1-pro-preview"
      ]
    },
    "LONGCTX": {
      "spread_top": 2,
      "chain": [
        "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        "openrouter/poolside/laguna-xs-2.1:free",
        "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
        "nvidia/minimaxai/minimax-m3",
        "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
        "google/gemini-3.6-flash",
        "nvidia/deepseek-ai/deepseek-v4-flash",
        "nvidia/z-ai/glm-5.2",
        "nvidia/stepfun-ai/step-3.7-flash",
        "nvidia/poolside/laguna-xs-2.1",
        "google/gemini-3.5-flash-lite"
      ]
    }
  },
  "dispatcher": {
    "model": "google/gemini-3.1-flash-lite",
    "fallbacks": [
      "groq/openai/gpt-oss-20b"
    ],
    "timeout_ms": 1500,
    "cache_ttl_s": 300,
    "confidence_floor": 0.6
  },
  "compaction": {
    "enabled": true,
    "trigger_tokens": 60000,
    "keep_recent": 6,
    "block_chars": 2000
  },
  "privacy": {
    "enabled": false,
    "block_patterns": [
      "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
      "AKIA[0-9A-Z]{16}",
      "ghp_[A-Za-z0-9]{36}",
      "sk-ant-[A-Za-z0-9-]{20,}",
      "xox[bap]-[0-9A-Za-z-]{10,}"
    ],
    "block_globs": [
      "**/.env",
      "**/id_rsa",
      "**/credentials.json",
      "secrets/**"
    ]
  },
  "images": {
    "chain": [
      "cfai/@cf/black-forest-labs/flux-1-schnell",
      "cfai/@cf/bytedance/stable-diffusion-xl-lightning",
      "cfai/@cf/lykon/dreamshaper-8-lcm",
      "cfai/@cf/leonardo/phoenix-1.0",
      "cfai/@cf/leonardo/lucid-origin",
      "cfai/@cf/stabilityai/stable-diffusion-xl-base-1.0"
    ]
  },
  "embeddings": {
    "chain": [
      "cfai/@cf/baai/bge-m3",
      "google/gemini-embedding-001"
    ]
  },
  "disabled_models": [
    "hf/Qwen/Qwen3-Coder-Next",
    "nvidia/deepseek-ai/deepseek-v4-pro",
    "google/gemini-3.1-pro-preview",
    "groq/llama-3.3-70b-versatile"
  ]
} as unknown as RouterConfig;

// M01-M30 developer MCP connections (MCP batch qualification). Inert public read model;
// installation stays with the normal Settings → Other programs (MCP) add form.
export const developerConnectionsData = [
  {
    "id": "local-git",
    "kind": "mcp",
    "name": "Local Git",
    "summary": "Read status, history and diffs of a chosen Git repository.",
    "description": "Read status, history and diffs of a chosen Git repository.",
    "status": "blocked",
    "costTier": "local-only",
    "source": "https://pypi.org/project/mcp-server-git/2026.11.4/",
    "documentation": "https://pypi.org/project/mcp-server-git/2026.11.4/",
    "qualification": "Not offered. The reason is listed under Limits.",
    "prerequisites": [
      "Git and a repository you choose; an OS-level fence before real project use"
    ],
    "permissions": [
      "Runs Git in the selected repository; commit, reset and checkout tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Git can run repository configuration (fsmonitor, external diff, textconv) during reads, and commit/reset tools have no read-only switch. Needs a real OS fence or a sanitized snapshot first.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free; runs on this computer.",
    "privacy": "local"
  },
  {
    "id": "postman",
    "kind": "mcp",
    "name": "Postman",
    "summary": "Read Postman collections and workspaces.",
    "description": "Read Postman collections and workspaces.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@postman/postman-mcp-server/v/2.15.0",
    "documentation": "https://www.npmjs.com/package/@postman/postman-mcp-server/v/2.15.0",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a Postman key in a test workspace holding only a fixture collection for an endpoint you own."
    ],
    "permissions": [
      "Sends requests to the Postman API with your key; collection runs can call real APIs",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Every tool uses your Postman key against the Postman cloud.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "storybook",
    "kind": "mcp",
    "name": "Storybook",
    "summary": "Find the stories for a component in your own running Storybook.",
    "description": "Find the stories for a component in your own running Storybook.",
    "status": "tested",
    "costTier": "local-only",
    "source": "https://www.npmjs.com/package/@storybook/addon-mcp/v/10.6.6",
    "documentation": "https://www.npmjs.com/package/@storybook/addon-mcp/v/10.6.6",
    "qualification": "Fixture-tested on Windows: in an owned Storybook the pinned addon found the component's two stories, previewed one and rendered its real label and disabled state; an unknown story ID was refused.",
    "prerequisites": [
      "Your own Storybook 10.6.6 project with @storybook/addon-mcp 10.6.6, running on 127.0.0.1:6006. No account."
    ],
    "permissions": [
      "Talks only to your Storybook dev server on 127.0.0.1:6006 and returns preview links",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Tested with the dev toolset only. Docs and test toolsets, other Storybook versions and remote Storybooks are not part of this recipe.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free; runs on this computer.",
    "privacy": "local",
    "recipePreview": {
      "transport": "http",
      "url": "http://127.0.0.1:6006/mcp",
      "secrets": [],
      "guide": [
        "In your own project add storybook@10.6.6 and @storybook/addon-mcp@10.6.6 at exact versions, list the addon in .storybook/main, and run storybook dev -p 6006 --host 127.0.0.1.",
        "Qualified: the dev toolset only (stories-find-by-component, stories-preview, get-storybook-story-instructions). Docs and test toolsets are not part of this recipe; keep them off in the addon options.",
        "A client header can ask for other toolsets; that is not server-side authorization. Choose the addon toolsets in main, not in Sara.",
        "Preview links point at your local Storybook. Open them only in a browser you trust with that project.",
        "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
        "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
      ]
    }
  },
  {
    "id": "aws",
    "kind": "mcp",
    "name": "AWS",
    "summary": "Read metadata about resources in an AWS sandbox account.",
    "description": "Read metadata about resources in an AWS sandbox account.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://pypi.org/project/awslabs.aws-api-mcp-server/1.6.0/",
    "documentation": "https://pypi.org/project/awslabs.aws-api-mcp-server/1.6.0/",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: provide a sandbox account profile with a read-only role for one region, and set READ_OPERATIONS_ONLY=true."
    ],
    "permissions": [
      "Runs AWS CLI operations with your credentials; mutating operations exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Reads go to your AWS account and can be billed.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "azure",
    "kind": "mcp",
    "name": "Azure",
    "summary": "Read metadata about resources in an Azure test subscription.",
    "description": "Read metadata about resources in an Azure test subscription.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@azure/mcp/v/4.0.0-beta.5",
    "documentation": "https://www.npmjs.com/package/@azure/mcp/v/4.0.0-beta.5",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: sign in with a Reader-only identity on one test resource group."
    ],
    "permissions": [
      "Uses your Azure sign-in; resource and deployment tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "The pinned build is a prerelease and every tool needs your Azure sign-in.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "google-cloud",
    "kind": "mcp",
    "name": "Google Cloud",
    "summary": "Read metadata about a Google Cloud test project.",
    "description": "Read metadata about a Google Cloud test project.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@google-cloud/gcloud-mcp/v/0.5.3",
    "documentation": "https://www.npmjs.com/package/@google-cloud/gcloud-mcp/v/0.5.3",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: install gcloud and sign in with a Viewer-only account on a test project."
    ],
    "permissions": [
      "Runs your installed gcloud CLI with your sign-in",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs your installed gcloud CLI signed in to a test project.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "terraform",
    "kind": "mcp",
    "name": "Terraform",
    "summary": "Look up Terraform provider and module documentation.",
    "description": "Look up Terraform provider and module documentation.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://releases.hashicorp.com/terraform-mcp-server/1.4.1/",
    "documentation": "https://releases.hashicorp.com/terraform-mcp-server/1.4.1/",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: install Docker, then test the image pinned by digest against the public registry."
    ],
    "permissions": [
      "Reads the public Terraform registry; workspace tools need an HCP Terraform token",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Shipped only as a native program or Docker image; Docker is not available here, so the Docker recipe could not be tested.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free; runs on this computer.",
    "privacy": "hybrid"
  },
  {
    "id": "pulumi",
    "kind": "mcp",
    "name": "Pulumi",
    "summary": "Inspect Pulumi stacks and previews.",
    "description": "Inspect Pulumi stacks and previews.",
    "status": "blocked",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@pulumi/mcp-server/v/0.2.0",
    "documentation": "https://www.npmjs.com/package/@pulumi/mcp-server/v/0.2.0",
    "qualification": "Not offered. The reason is listed under Limits.",
    "prerequisites": [
      "A Pulumi Cloud account; a licensed pinned release"
    ],
    "permissions": [
      "Uses your Pulumi Cloud token",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "The pinned package declares no license and ships no license file.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "kubernetes",
    "kind": "mcp",
    "name": "Kubernetes",
    "summary": "Inspect pods, events and logs in a test cluster namespace.",
    "description": "Inspect pods, events and logs in a test cluster namespace.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://www.npmjs.com/package/kubernetes-mcp-server/v/0.1.2",
    "documentation": "https://www.npmjs.com/package/kubernetes-mcp-server/v/0.1.2",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: provide a test cluster and a namespace-scoped read-only service-account kubeconfig."
    ],
    "permissions": [
      "Uses your kubeconfig; exec, apply and delete tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs a running test cluster; none is available here.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "argo-cd",
    "kind": "mcp",
    "name": "Argo CD",
    "summary": "Read Argo CD application status and drift.",
    "description": "Read Argo CD application status and drift.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://www.npmjs.com/package/argocd-mcp/v/0.9.0",
    "documentation": "https://www.npmjs.com/package/argocd-mcp/v/0.9.0",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: provide an Argo CD instance with a fixture application and a read-only role token; set MCP_READ_ONLY=true."
    ],
    "permissions": [
      "Uses your Argo CD token; sync and rollback tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs a running Argo CD server and a read-only token.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "vercel",
    "kind": "mcp",
    "name": "Vercel",
    "summary": "Read Vercel deployments and logs.",
    "description": "Read Vercel deployments and logs.",
    "status": "blocked",
    "costTier": "provider",
    "source": "https://vercel.com/docs/agent-resources/vercel-mcp",
    "documentation": "https://vercel.com/docs/agent-resources/vercel-mcp",
    "qualification": "Not offered. The reason is listed under Limits.",
    "prerequisites": [
      "A Vercel account and a Sara hosted-MCP sign-in flow"
    ],
    "permissions": [
      "Hosted service with Vercel sign-in",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Hosted only, with OAuth sign-in. There is no version to pin and Sara has no hosted MCP sign-in flow.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "netlify",
    "kind": "mcp",
    "name": "Netlify",
    "summary": "Read Netlify deploys and logs.",
    "description": "Read Netlify deploys and logs.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@netlify/mcp/v/1.21.0",
    "documentation": "https://www.npmjs.com/package/@netlify/mcp/v/1.21.0",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a token for a test team with one site and an existing deploy."
    ],
    "permissions": [
      "Uses your Netlify token; deploy and build tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Every tool uses your Netlify token.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "mongodb",
    "kind": "mcp",
    "name": "MongoDB",
    "summary": "Query a MongoDB collection and explain a query plan.",
    "description": "Query a MongoDB collection and explain a query plan.",
    "status": "blocked",
    "costTier": "mixed",
    "source": "https://www.npmjs.com/package/mongodb-mcp-server/v/3.2.2",
    "documentation": "https://www.npmjs.com/package/mongodb-mcp-server/v/3.2.2",
    "qualification": "Not offered. The reason is listed under Limits.",
    "prerequisites": [
      "A fixed upstream release that enforces its row cap"
    ],
    "permissions": [
      "Reads and can change databases the user can reach",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Upstream defect in 3.2.2 (latest): find with limit 0 ignores the configured row cap; the fixture returned 20 rows against a cap of 5.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "redis",
    "kind": "mcp",
    "name": "Redis",
    "summary": "Inspect keys and expiry times in a Redis database.",
    "description": "Inspect keys and expiry times in a Redis database.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://pypi.org/project/redis-mcp-server/0.5.1/",
    "documentation": "https://pypi.org/project/redis-mcp-server/0.5.1/",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: run Redis 7 or later with an ACL user limited to one key prefix and read commands."
    ],
    "permissions": [
      "Reads and can change keys; most of its tools write",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs a real Redis server. The server has no read-only switch, so only a Redis ACL user can limit it; the emulator tried here does not enforce ACLs.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "elasticsearch-and-opensearch",
    "kind": "mcp",
    "name": "Elasticsearch and OpenSearch",
    "summary": "Search an OpenSearch or Elasticsearch index and read its mapping.",
    "description": "Search an OpenSearch or Elasticsearch index and read its mapping.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://pypi.org/project/opensearch-mcp-server-py/0.12.0/",
    "documentation": "https://pypi.org/project/opensearch-mcp-server-py/0.12.0/",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: run a single-node OpenSearch with a read-only role on one fixture index."
    ],
    "permissions": [
      "Sends queries to your cluster; a generic API tool exists",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs a running OpenSearch or Elasticsearch cluster.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "clickhouse",
    "kind": "mcp",
    "name": "ClickHouse",
    "summary": "Inspect a ClickHouse schema and query plan.",
    "description": "Inspect a ClickHouse schema and query plan.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://pypi.org/project/mcp-clickhouse/0.7.0/",
    "documentation": "https://pypi.org/project/mcp-clickhouse/0.7.0/",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: run ClickHouse with a readonly profile user and set CLICKHOUSE_ALLOW_WRITE_ACCESS=false."
    ],
    "permissions": [
      "Runs SQL on your ClickHouse server",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs a ClickHouse server; none runs natively on this Windows PC.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "snowflake",
    "kind": "mcp",
    "name": "Snowflake",
    "summary": "Run a bounded query in a Snowflake test warehouse.",
    "description": "Run a bounded query in a Snowflake test warehouse.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp",
    "documentation": "https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create an extra-small warehouse with a resource monitor and a read-only role, and approve the credit spend."
    ],
    "permissions": [
      "Runs SQL in your Snowflake account; queries spend warehouse credits",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Every query spends credits in your Snowflake account.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "neon",
    "kind": "mcp",
    "name": "Neon",
    "summary": "Read Neon project and branch metadata.",
    "description": "Read Neon project and branch metadata.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://neon.com/docs/ai/neon-mcp-server",
    "documentation": "https://neon.com/docs/ai/neon-mcp-server",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a Neon key for a test project with one branch."
    ],
    "permissions": [
      "Hosted service using your Neon key; branch create and delete tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "The local package is deprecated; the hosted server needs your Neon key and cannot be pinned.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "qdrant",
    "kind": "mcp",
    "name": "Qdrant",
    "summary": "Search a local Qdrant collection by meaning.",
    "description": "Search a local Qdrant collection by meaning.",
    "status": "tested",
    "costTier": "local-only",
    "source": "https://pypi.org/project/mcp-server-qdrant/0.8.1/",
    "documentation": "https://pypi.org/project/mcp-server-qdrant/0.8.1/",
    "qualification": "Fixture-tested on Windows: the pinned official server stored three synthetic notes, then a read-only start listed only qdrant-find and returned the expected note first; the collection was unchanged.",
    "prerequisites": [
      "uv/uvx; Python 3.12 is fetched by uv if missing. No account."
    ],
    "permissions": [
      "Reads one embedded collection in the server's own folder; downloads its embedding model once",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Tested with an embedded collection only. Qdrant Cloud, a Qdrant server URL and API keys are not part of this recipe; dependencies below the top-level pin are not locked.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free; runs on this computer.",
    "privacy": "local",
    "recipePreview": {
      "transport": "stdio",
      "command": "uvx",
      "args": [
        "--python=3.12",
        "mcp-server-qdrant==0.8.1"
      ],
      "environment": [
        {
          "name": "QDRANT_LOCAL_PATH",
          "publicValue": "qdrant-store",
          "purpose": "Folder for the embedded collection, relative to this server's own folder. Keep the default unless you copy in a collection you made yourself."
        },
        {
          "name": "COLLECTION_NAME",
          "publicValue": "sara-notes",
          "purpose": "The one collection this server searches. The search tool cannot pick a different collection."
        },
        {
          "name": "QDRANT_READ_ONLY",
          "publicValue": "true",
          "purpose": "true removes the store tool so the collection cannot be changed. Choose false only when you want Sara to add notes, each one approved."
        },
        {
          "name": "EMBEDDING_MODEL",
          "publicValue": "sentence-transformers/all-MiniLM-L6-v2",
          "purpose": "The qualified local embedding model. It is downloaded once from Hugging Face on first start; no account is needed."
        },
        {
          "name": "FASTEMBED_CACHE_PATH",
          "publicValue": "fastembed-cache",
          "purpose": "Where the downloaded embedding model is kept, relative to this server's own folder."
        },
        {
          "name": "HF_HUB_DISABLE_TELEMETRY",
          "publicValue": "1",
          "purpose": "1 turns off Hugging Face download telemetry for the model download."
        }
      ],
      "substitutions": [],
      "secrets": [],
      "guide": [
        "Requires uv/uvx. The recipe asks uv for Python 3.12 because the default Python 3.14 has no prebuilt pydantic-core wheel for this pin and tries a source build.",
        "Qualified: official mcp-server-qdrant 0.8.1 against an embedded synthetic collection on Windows. Qdrant Cloud, a Qdrant server URL and API keys are not part of this recipe.",
        "Keep Read-only at true. qdrant-find then is the only tool; set it to Ask me first. If you choose false, set qdrant-store to Ask me first.",
        "The first start downloads about 90 MB of model files from Hugging Face. Dependencies below the top-level pin are not locked; review them before use with private notes.",
        "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
        "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
      ]
    }
  },
  {
    "id": "pinecone",
    "kind": "mcp",
    "name": "Pinecone",
    "summary": "Query a Pinecone index namespace.",
    "description": "Query a Pinecone index namespace.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@pinecone-database/mcp/v/0.4.0",
    "documentation": "https://www.npmjs.com/package/@pinecone-database/mcp/v/0.4.0",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a key for a test project with a fixture index, and approve the cost."
    ],
    "permissions": [
      "Sends queries to your Pinecone project; upsert and index tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Every query uses your Pinecone project and can be billed.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "datadog",
    "kind": "mcp",
    "name": "Datadog",
    "summary": "Read Datadog logs and traces for a service.",
    "description": "Read Datadog logs and traces for a service.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://github.com/datadog-labs/mcp-server",
    "documentation": "https://github.com/datadog-labs/mcp-server",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create read-only keys for a test organization with a synthetic service."
    ],
    "permissions": [
      "Hosted service using your Datadog keys",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "A managed regional service that uses your Datadog keys.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "grafana",
    "kind": "mcp",
    "name": "Grafana",
    "summary": "Read Grafana dashboards and query a data source.",
    "description": "Read Grafana dashboards and query a data source.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://github.com/grafana/mcp-grafana/releases/tag/v2.2.0",
    "documentation": "https://github.com/grafana/mcp-grafana/releases/tag/v2.2.0",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: run Grafana or a test stack with a Viewer service-account token, and use --disable-write."
    ],
    "permissions": [
      "Uses your Grafana token; dashboard and alert write tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs a Grafana instance and token; shipped as a native program or Docker image.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "new-relic",
    "kind": "mcp",
    "name": "New Relic",
    "summary": "Read New Relic telemetry for an application.",
    "description": "Read New Relic telemetry for an application.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://docs.newrelic.com/docs/agentic-ai/mcp/overview/",
    "documentation": "https://docs.newrelic.com/docs/agentic-ai/mcp/overview/",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a user key for a test account with a synthetic application."
    ],
    "permissions": [
      "Hosted service using your New Relic key",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "A managed service that uses your New Relic key.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "posthog",
    "kind": "mcp",
    "name": "PostHog",
    "summary": "Read PostHog insights and funnels.",
    "description": "Read PostHog insights and funnels.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://github.com/PostHog/mcp",
    "documentation": "https://github.com/PostHog/mcp",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a read-only personal key on a test project with a fixture funnel."
    ],
    "permissions": [
      "Hosted service using your PostHog key; flag and experiment tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "A managed service that uses your PostHog key.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "launchdarkly",
    "kind": "mcp",
    "name": "LaunchDarkly",
    "summary": "Read LaunchDarkly feature flag state.",
    "description": "Read LaunchDarkly feature flag state.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@launchdarkly/mcp-server/v/0.7.2",
    "documentation": "https://www.npmjs.com/package/@launchdarkly/mcp-server/v/0.7.2",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a Reader-role token for a test project with a fixture flag."
    ],
    "permissions": [
      "Uses your LaunchDarkly token; targeting tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Every tool uses your LaunchDarkly token.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "stripe",
    "kind": "mcp",
    "name": "Stripe",
    "summary": "Read Stripe test-mode customers and payments.",
    "description": "Read Stripe test-mode customers and payments.",
    "status": "blocked",
    "costTier": "provider",
    "source": "https://docs.stripe.com/mcp",
    "documentation": "https://docs.stripe.com/mcp",
    "qualification": "Not offered. The reason is listed under Limits.",
    "prerequisites": [
      "A Stripe test-mode key and a reviewed test-mode-only fence"
    ],
    "permissions": [
      "Uses your Stripe key; charge and refund tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "The local package is deprecated without security fixes; the hosted server cannot be pinned and payment tools need a reviewed test-mode fence.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "auth0",
    "kind": "mcp",
    "name": "Auth0",
    "summary": "Inspect applications and roles in an Auth0 development tenant.",
    "description": "Inspect applications and roles in an Auth0 development tenant.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://www.npmjs.com/package/@auth0/auth0-mcp-server/v/0.1.0-beta.19",
    "documentation": "https://www.npmjs.com/package/@auth0/auth0-mcp-server/v/0.1.0-beta.19",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a development tenant with synthetic users and run the server with --read-only."
    ],
    "permissions": [
      "Uses your Auth0 sign-in; user, role and application write tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "A prerelease that signs in through a browser and needs a dedicated development tenant.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "jenkins",
    "kind": "mcp",
    "name": "Jenkins",
    "summary": "Read an existing Jenkins build and its console log.",
    "description": "Read an existing Jenkins build and its console log.",
    "status": "needs-account",
    "costTier": "mixed",
    "source": "https://plugins.jenkins.io/mcp-server/",
    "documentation": "https://plugins.jenkins.io/mcp-server/",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: provision a test controller with the pinned plugin and one finished job, and give Sara a read-only token."
    ],
    "permissions": [
      "Talks to your Jenkins controller with your token; build trigger tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Runs inside a Jenkins controller you provision, with an existing finished job.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Free when you run the service yourself; hosted versions cost extra.",
    "privacy": "hybrid"
  },
  {
    "id": "buildkite",
    "kind": "mcp",
    "name": "Buildkite",
    "summary": "Read an existing Buildkite build and its job logs.",
    "description": "Read an existing Buildkite build and its job logs.",
    "status": "needs-account",
    "costTier": "provider",
    "source": "https://github.com/buildkite/buildkite-mcp-server/releases/tag/v1.31.0",
    "documentation": "https://github.com/buildkite/buildkite-mcp-server/releases/tag/v1.31.0",
    "qualification": "Pinned upstream identified from its registry. Not run: acceptance needs your own account, key, service or spending.",
    "prerequisites": [
      "Owner step: create a read-only token for one pipeline with an existing build, and install Docker."
    ],
    "permissions": [
      "Uses your Buildkite token; build trigger tools exist",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "Needs your Buildkite token; shipped as a native program or Docker image.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  },
  {
    "id": "circleci",
    "kind": "mcp",
    "name": "CircleCI",
    "summary": "Read an existing CircleCI pipeline result.",
    "description": "Read an existing CircleCI pipeline result.",
    "status": "blocked",
    "costTier": "provider",
    "source": "https://circleci.com/docs/guides/toolkit/circleci-mcp-overview/",
    "documentation": "https://circleci.com/docs/guides/toolkit/circleci-mcp-overview/",
    "qualification": "Not offered. The reason is listed under Limits.",
    "prerequisites": [
      "A CircleCI account and a Sara hosted-MCP sign-in flow"
    ],
    "permissions": [
      "Hosted service with CircleCI sign-in",
      "Review tool permissions explicitly; read access does not authorize writes or spend.",
      "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
    ],
    "limitations": [
      "The local package is deprecated; the hosted replacement uses OAuth sign-in, cannot be pinned, and Sara has no hosted MCP sign-in flow.",
      "No authenticated vendor feature execution or other operating-system qualification is claimed."
    ],
    "cost": "Your provider account, plan and usage charges apply. No paid call was made.",
    "privacy": "external"
  }
] as const;

---
name: quorum-function-registry
description: Complete guide to the function registry system. Read when any agent creates, modifies, or needs to navigate functions or classes in the codebase. The registry eliminates codebase search costs — 99% cheaper than reading files.
---

# Atlas Function Registry

## When to Use

Read when any agent creates, modifies, or needs to navigate functions
or classes in the codebase. The registry eliminates codebase search costs.

## Why This Exists

Without registry:
  Find function X → read entire file (15,000 tokens)
  Find all callers → read 3-5 more files
  Total navigation cost: ~60,000 tokens

With registry:
  Query registry → get file + line number instantly
  Read only those specific lines
  Total navigation cost: ~200 tokens
  Savings: 99%+

## Function Entry Schema

```json
{
  "id": "fn_[auto-increment]",
  "type": "function | class | method | hook | middleware | util",
  "name": "[exact name as in code]",
  "file": "[relative path from project root]",
  "line_start": 0,
  "line_end": 0,
  "purpose": "[what it does — one plain-English sentence]",
  "parameters": [
    {
      "name": "[param name]",
      "type": "[type]",
      "required": true,
      "description": "[what it's for]"
    }
  ],
  "returns": {
    "type": "[return type]",
    "description": "[what it returns and when]"
  },
  "called_from": [
    {
      "file": "[path]",
      "line": 0,
      "function": "[which function contains this call]",
      "reason": "[why it's called from here]"
    }
  ],
  "calls": [
    {
      "function": "[name]",
      "file": "[path]",
      "reason": "[why this dependency exists]"
    }
  ],
  "design_note": "[why built this way — only if non-obvious or important]",
  "agent_that_created": "[agent name | human]",
  "session": "[session ID]",
  "last_modified_session": "[session ID]",
  "deleted": false,
  "tags": ["[searchable descriptive tags]"]
}
```

## Navigation Protocol for Agents

To find a function by name:
```
Read function-registry.json
Filter where name = "[target]"
Use: file + line_start to navigate directly
```

To find functions by purpose:
```
Filter function-registry.json where tags contain [relevant tags]
OR where purpose contains [keywords]
Return: matching entries with file + line
```

To understand a function's dependencies:
```
Read registry entry for function
Read calls array → these are its dependencies
Each dependency also has a registry entry
```

To find all places a function is called:
```
Read registry entry for function
Read called_from array
Each entry: exact file, line, and context
```

## Update Rules for Agents

ALWAYS update registry when:
- New function or class created (add new entry)
- Function signature changes (update parameters, returns)
- Function renamed (update name, add previous_name field)
- Function deleted (set `deleted: true` — never remove entry)
- New call site added (update `called_from` array)

NEVER:
- Delete entries from registry
- Leave `purpose` field empty
- Skip `tags` (minimum 2 tags per entry)

## Example: Minimal Valid Entry

```json
{
  "id": "fn_001",
  "type": "function",
  "name": "createUser",
  "file": "src/auth/users.js",
  "line_start": 42,
  "line_end": 67,
  "purpose": "Creates a new user record with hashed password and default role",
  "parameters": [
    {"name": "email", "type": "string", "required": true, "description": "User email address"},
    {"name": "password", "type": "string", "required": true, "description": "Plain text password — hashed internally"}
  ],
  "returns": {"type": "Promise<User>", "description": "The created user object without password field"},
  "called_from": [
    {"file": "src/routes/auth.js", "line": 28, "function": "registerHandler", "reason": "Creates user on POST /register"}
  ],
  "calls": [
    {"function": "hashPassword", "file": "src/auth/crypto.js", "reason": "Hash password before storing"}
  ],
  "design_note": "Password is hashed here rather than in route handler to enforce policy regardless of entry point",
  "agent_that_created": "quorum-backend-architect",
  "session": "s_001",
  "last_modified_session": "s_001",
  "deleted": false,
  "tags": ["auth", "user", "create", "database"]
}
```

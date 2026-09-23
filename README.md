# Ponto Lanchonete (PWA + Neon)

Os dados ficam no Postgres do **Neon**; o app roda no **Render** como *Web Service* (Node).

## 1. Neon
1. Crie um projeto em https://neon.tech.
2. Em **Connect**, copie a *connection string* (`postgresql://...neon.tech/neondb?sslmode=require`).
3. Não precisa criar tabela: o servidor cria a tabela `employees` sozinho na primeira execução.

## 2. GitHub
Suba esta pasta inteira (com `server.js`, `package.json` e `public/`) para o repositório.

## 3. Render
1. **New → Web Service** apontando para o repositório (ou **Blueprint**, que lê o `render.yaml`).
2. Runtime: Node · Build: `npm install` · Start: `npm start`.
3. Em **Environment**, adicione:
   - `DATABASE_URL` = a string do Neon
   - `ADMIN_PASSWORD` = a senha da área administrativa
4. Deploy.

## Rodar local
```
npm install
DATABASE_URL="postgresql://..." ADMIN_PASSWORD="minha-senha" npm start
```

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

## Lista de colaboradores Tenda
A lista fica em `data/colaboradores.json` (chapa, nome, setor, função). A cada início do servidor a tabela
`colaboradores` do Neon é sincronizada com esse arquivo. No totem, o colaborador Tenda digita só a matrícula
e o nome vem da lista. Para atualizar: edite o JSON e faça um novo deploy.

## Controle de refeição (aba do admin)
Área administrativa → aba **Controle de refeição**: Resumo (totais + gráficos), Diretoria, Colaboradores,
Conselho e Securitizadora. Cada grupo tem a grade de 30 dias a partir da data de início; toque numa célula
para marcar/desmarcar, e use *editar* / *+ Pessoa* para alterar a lista.
A carga inicial vem de `data/refeicao_inicial.json` e só roda quando as tabelas `refeicao_pessoas` e
`refeicao_marcas` estão vazias; depois disso tudo é editado pelo app (nada é sobrescrito no deploy).
Quem tem matrícula numérica única também pode registrar ponto no totem.

**Atualização automática:** toda *entrada* registrada no totem marca o dia no controle de refeição.
Colaborador Tenda entra pela matrícula (se ainda não estiver na grade, é criado em *Colaboradores*);
Parceiro entra pelo CPF (criado em *Parceiros*, com a empresa). Vários registros no mesmo dia contam 1 refeição.
O gráfico de parceiros aparece no *Resumo* e só existe na área administrativa (a API exige a senha do admin).
O período mostrado por padrão é o de 30 dias que contém a data de hoje; use ‹ › ou a data para navegar.

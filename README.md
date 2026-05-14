# Handoff Flow Auditor

Um plugin para Figma que revisa fluxos de design antes do handoff para o time de desenvolvimento — e devolve um score com os pontos que precisam de atenção.

---

## O problema que ele resolve

Antes de entregar um fluxo para dev, é comum que detalhes escapem: telas sem nomenclatura clara, espaçamentos inconsistentes, estados faltando, componentes fora do padrão. Essas inconsistências só aparecem no olho do desenvolvedor — e aí já é tarde.

O Handoff Flow Auditor faz essa revisão de forma rápida e sistemática, direto no Figma, sem precisar sair do arquivo.

---

## Como funciona

Você escolhe o tipo de fluxo que está auditando (Cadastro, Pagamento, Busca, etc.), define o escopo (página inteira, uma section ou só a seleção atual) e roda a auditoria. Em segundos o plugin devolve:

- Um **score de 0 a 100** com classificação (Pronto, Ressalvas, Revisar ou Bloqueado)
- Uma lista de **issues por severidade** — crítico, alto, médio e baixo
- Para cada issue: uma descrição do problema e uma recomendação de como corrigir
- Atalhos diretos para navegar até o frame com problema no canvas
- Um painel de **pontos fortes** do fluxo
- Um resumo dos **estados cobertos** (sucesso, erro, vazio, etc.)
- Uma visão geral das **telas** auditadas com score individual

---

## O que é auditado

- Nomenclatura dos frames e layers
- Consistência de espaçamento entre seções
- Uso de auto layout
- Cobertura de casos de uso esperados para o tipo de fluxo
- Estados necessários (erro, vazio, loading, confirmação)
- Contraste e acessibilidade básica
- Organização estrutural do arquivo

---

## Funcionalidades

**Histórico de auditorias** — cada auditoria fica salva localmente no arquivo. Você pode acompanhar a evolução do score ao longo do tempo e ver quais fluxos já foram revisados.

**Relatório em Markdown** — ao final de qualquer auditoria, um botão copia o relatório completo em formato Markdown, pronto para colar no Notion, Jira, Linear ou qualquer ferramenta do time.

**Modo escuro** — porque ninguém merece auditar com fundo branco às 23h.

---

## Para quem é

- Designers que fazem handoff para times de desenvolvimento
- Design leads que revisam entregas antes de subir para sprint
- Times que querem padronizar a qualidade dos arquivos Figma

---

## Status

Plugin em desenvolvimento ativo. Feedbacks e sugestões são bem-vindos via issues.

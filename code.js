// Handoff Flow Auditor — code.js
// Runs in Figma plugin sandbox. No imports, no require, pure JS.

figma.showUI(__html__, { width: 380, height: 600, themeColors: true });

// ─── History Persistence ──────────────────────────────────────────────────────
var _HIST_KEY = 'hfa-history-v1-' + figma.root.id;
var _HIST_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function saveHistory(entries) {
  figma.clientStorage.setAsync(_HIST_KEY, { entries: entries, ts: Date.now() }).catch(function() {});
}

function loadHistory(cb) {
  figma.clientStorage.getAsync(_HIST_KEY).then(function(data) {
    if (!data || !data.ts || (Date.now() - data.ts) > _HIST_TTL) { cb([]); return; }
    cb(Array.isArray(data.entries) ? data.entries : []);
  }).catch(function() { cb([]); });
}

// ─── Rules ────────────────────────────────────────────────────────────────────
var COMPONENT_NAMES = {
  context:     ["Handoff / Context", "Context Card", "handoff-context"],
  rule:        ["Handoff / Rule Card", "Rule Card", "handoff-rule"],
  decision:    ["Handoff / Decision Card", "Decision Card", "handoff-decision"],
  state:       ["Handoff / State Card", "State Card", "handoff-state"],
  pending:     ["Handoff / Open Question Card", "Open Question Card", "Pendência"],
  outOfScope:  ["Handoff / Out of Scope Card", "Out of Scope Card"],
  marker:      ["Handoff / Marker", "Marker", "handoff-marker"],
};

var CARD_TYPE_KEYWORDS = {
  "CONTEXTO":       ["CONTEXTO", "CONTEXT", "JTBD"],
  "REGRA":          ["REGRA", "RULE"],
  "DECISÃO":        ["DECISÃO", "DECISAO", "DECISION"],
  "ESTADO":         ["ESTADO", "STATE"],
  "NAVEGAÇÃO":      ["NAVEGAÇÃO", "NAVEGACAO", "NAVIGATION"],
  "VALIDAÇÃO":      ["VALIDAÇÃO", "VALIDACAO", "VALIDATION"],
  "PENDÊNCIA":      ["PENDÊNCIA", "PENDENCIA", "PENDING", "OPEN QUESTION"],
  "FORA DE ESCOPO": ["FORA DE ESCOPO", "OUT OF SCOPE"],
};

// ─── Termos ambíguos — 4 categorias, 60+ padrões ─────────────────────────────
// Cada categoria tem uma recomendação diferente para o designer

var AMBIGUOUS_CATEGORIES = {

  // Decisão ainda não tomada — converter em PENDÊNCIA com owner + prazo
  indefinition: [
    "a definir", "a decidir", "a confirmar", "a verificar", "a avaliar",
    "tbd", "tba", "wip", "em aberto", "não definido", "não decidido",
    "não confirmado", "talvez", "possivelmente", "provavelmente",
    "pode ser", "depende", "a critério", "fica a critério",
    "ainda não sabemos", "ainda não definido", "sem definição",
    "a validar", "validar com", "confirmar com", "checar com",
    "alinhar com", "alinhamento pendente", "pendente de alinhamento",
    "aguardando definição", "aguardando aprovação", "aguardando retorno"
  ],

  // Referência a outro lugar sem link ou identificador verificável
  vague_reference: [
    "idem", "idem ao", "mesmo que", "igual ao", "similar ao",
    "seguir o padrão", "seguir o modelo", "seguir o mesmo padrão",
    "conforme padrão", "conforme definido", "conforme combinado",
    "conforme anteriormente", "como no outro fluxo", "como no fluxo de",
    "manter consistência", "manter o padrão", "manter igual",
    "ver fluxo anterior", "ver tela anterior", "ver componente",
    "igual ao componente", "reusar o mesmo", "usar o mesmo de",
    "baseado no", "inspirado no", "parecido com", "análogo ao",
    "conforme o design system", "ver no figma", "ver no zeplin",
    "ver documentação", "conforme especificado", "já especificado",
    "como já discutido", "como acordado", "como combinamos"
  ],

  // Decisão postergada que vai chegar para Eng sem resolução
  deferral: [
    "ver depois", "definir depois", "ajustar depois", "revisar depois",
    "ajustar no dev", "resolver no dev", "acertar no dev",
    "revisar antes do dev", "ajustar antes do handoff",
    "afinar depois", "afinar com o time", "detalhar depois",
    "a ser detalhado", "será detalhado", "detalhes a definir",
    "simplificado por ora", "versão simplificada por ora",
    "por enquanto assim", "provisório", "temporário",
    "versão inicial", "primeira versão — ajustar", "iterar depois",
    "próxima sprint", "próximo ciclo", "fase 2", "fase dois",
    "v2", "versão 2", "futuro", "no futuro", "eventually",
    "backlog", "fica no backlog", "vai pro backlog"
  ],

  // Dependência de sistema ou squad sem identificação concreta
  unnamed_dependency: [
    "o backend", "o back", "o servidor", "a api", "as apis",
    "o serviço", "o sistema", "o bff", "o microserviço",
    "o time de dados", "o time de engenharia", "o time técnico",
    "via api", "via backend", "via serviço", "via integração",
    "conforme o backend", "conforme a api", "retorno do servidor",
    "dado vindo do back", "dado do servidor", "campo da api",
    "depende do backend", "depende da api", "depende do serviço",
    "depende do time", "depende do squad",
    "o squad define", "o squad decide", "eng decide",
    "ver com o squad", "definir com o squad", "alinhar com o squad",
    "engenharia vai definir", "técnico vai definir",
    "a ser implementado pelo back", "responsabilidade do back"
  ]
};

// Lista plana ordenada por comprimento DESC — termos mais específicos testados primeiro
// Evita que "depende" capture "depende do backend" antes de unnamed_dependency
var AMBIGUOUS_TERMS = (function() {
  var all = [];
  var cats = Object.keys(AMBIGUOUS_CATEGORIES);
  for (var i = 0; i < cats.length; i++) {
    var terms = AMBIGUOUS_CATEGORIES[cats[i]];
    for (var j = 0; j < terms.length; j++) all.push(terms[j]);
  }
  all.sort(function(a, b) { return b.length - a.length; });
  return all;
})();

// Mapa reverso pré-computado: term → categoria — O(1) vs O(n*m) da busca linear.
// Avalia na mesma ordem de prioridade do algoritmo original:
// unnamed_dependency e vague_reference antes de deferral/indefinition.
var _TERM_CATEGORY_MAP = (function() {
  var map = {};
  var ORDER = ["unnamed_dependency", "vague_reference", "deferral", "indefinition"];
  for (var o = 0; o < ORDER.length; o++) {
    var cat = ORDER[o];
    var terms = AMBIGUOUS_CATEGORIES[cat];
    for (var j = 0; j < terms.length; j++) {
      if (!map[terms[j]]) map[terms[j]] = cat; // first match wins (prioridade pela ordem)
    }
  }
  return map;
})();

// Retorna a categoria de um termo encontrado (para recomendação específica).
function getAmbiguousCategory(term) {
  return _TERM_CATEGORY_MAP[term] || "indefinition";
}

var AMBIGUOUS_RECOMMENDATIONS = {
  indefinition:        "Converta em card de PENDÊNCIA com owner e prazo definidos.",
  vague_reference:     "Adicione o número do frame, link ou nome exato do componente referenciado.",
  deferral:            "Resolva antes do handoff ou registre como PENDÊNCIA bloqueante com data de resolução.",
  unnamed_dependency:  "Nomeie o sistema (endpoint, serviço ou squad) e indique quem é o responsável técnico."
};

var TRIGGER_KW = ["ao ", "quando ", "se ", "ao tocar", "ao clicar", "ao digitar", "ao pressionar", "on tap", "on click", "when "];
var RESULT_KW  = ["deve ", "should ", "exibe", "mostra", "navega", "limpa", "redireciona", "abre", "fecha", "display", "show", "navigate"];

var DECISION_POS = ["sim", "yes", "sucesso", "success", "encontrou", "válido", "aprovado"];
var DECISION_NEG = ["não", "nao", "no", "falhou", "failed", "sem resultado", "vazio", "empty"];
var DECISION_ERR = ["erro", "error", "falha", "failure", "técnico", "timeout"];

var FLOW_STATES = {
  "Busca":         ["Default", "Input preenchido", "Loading", "Resultado encontrado", "Sem resultado", "Erro técnico", "Limpar busca", "Seleção de item"],
  "Cadastro":      ["Default", "Preenchimento", "Validação de campo", "Erro de campo", "Sucesso", "Abandono/cancelamento"],
  "Contratação":   ["Oferta", "Revisão", "Confirmação", "Loading/processamento", "Sucesso", "Erro", "Cancelamento", "Não elegível"],
  "Pagamento":     ["Revisão", "Processamento", "Sucesso", "Falha", "Expirado", "Comprovante"],
  "Consulta/lista":["Loading", "Lista com dados", "Empty state", "Erro", "Filtro/busca", "Atualização"],
  "Edição":        ["Estado atual", "Alteração", "Confirmação", "Sucesso", "Erro", "Cancelar"],
  "Outro":         ["Entrada", "Caminho principal", "Estado final"],
};

var CRITICAL_STATES = {
  "Busca":          ["Loading", "Sem resultado", "Erro técnico"],
  "Cadastro":       ["Validação de campo", "Sucesso"],
  "Contratação":    ["Erro", "Não elegível"],
  "Pagamento":      ["Falha", "Sucesso"],
  "Consulta/lista": ["Empty state", "Erro"],
  "Edição":         ["Sucesso", "Erro"],
  "Outro":          ["Estado final"],
};

// Pesos rebalanceados: nenhuma dimensão domina isolada (max 14%).
// Adicionadas: organization (organização em sections) e specs (specs de espaçamento).
// Traceabilidade subiu de 5% para 10% — marcadores são críticos para navegação dev.
var DIM_WEIGHTS = {
  context:      0.10, // Contexto e objetivo do handoff
  organization: 0.10, // Organização em Sections do Figma
  structure:    0.10, // Estrutura e escopo do fluxo
  decisions:    0.14, // Decisões e caminhos alternativos
  states:       0.14, // Estados e exceções cobertos
  behaviors:    0.12, // Qualidade dos cards / implementabilidade
  specs:        0.12, // Specs de espaçamento para tokens
  traceability: 0.10, // Rastreabilidade marcador ↔ card
  layout:       0.08, // Layout e espaçamento das telas
};
var DIM_LABELS = {
  context:      "Contexto da jornada",
  organization: "Organização em Sections",
  structure:    "Estrutura do fluxo",
  decisions:    "Decisões e caminhos",
  states:       "Estados e exceções",
  behaviors:    "Comportamentos",
  specs:        "Specs de espaçamento",
  traceability: "Rastreabilidade",
  layout:       "Layout e espaçamento",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
var _issueId = 0;
function mkIssue(severity, dim, title, desc, rec, nodeId, blocker) {
  return { id: "i" + (++_issueId), severity: severity, dimension: dim, title: title, description: desc, recommendation: rec, nodeId: nodeId || null, isCriticalBlocker: !!blocker };
}

function includes(arr, val) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === val) return true;
  return false;
}

function strIncludes(str, sub) {
  return str.indexOf(sub) !== -1;
}

function arrSome(arr, fn) {
  for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return true;
  return false;
}

function arrFilter(arr, fn) {
  var out = [];
  for (var i = 0; i < arr.length; i++) if (fn(arr[i])) out.push(arr[i]);
  return out;
}

function arrMap(arr, fn) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(fn(arr[i]));
  return out;
}

function arrFind(arr, fn) {
  for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return arr[i];
  return null;
}

// ─── Unicode math font normalizer ────────────────────────────────────────────
// Converte variantes bold/italic/sans do unicode matemático para ASCII puro.
// Necessário para comparar nomes de páginas com chars bold (ex: 𝙀𝙉𝙏𝙍𝙀𝙂𝘼𝙍 → ENTREGAR).
function _normalizeName(str) {
  var MATH_RANGES = [
    [0x1D400,65],[0x1D41A,97], // Bold Cap/Small
    [0x1D434,65],[0x1D44E,97], // Italic Cap/Small
    [0x1D468,65],[0x1D482,97], // Bold Italic Cap/Small
    [0x1D49C,65],[0x1D4B6,97], // Script Cap/Small
    [0x1D4D0,65],[0x1D4EA,97], // Bold Script Cap/Small
    [0x1D504,65],[0x1D51E,97], // Fraktur Cap/Small
    [0x1D538,65],[0x1D552,97], // Double-struck Cap/Small
    [0x1D56C,65],[0x1D586,97], // Bold Fraktur Cap/Small
    [0x1D5A0,65],[0x1D5BA,97], // Sans-serif Cap/Small
    [0x1D5D4,65],[0x1D5EE,97], // Sans Bold Cap/Small
    [0x1D608,65],[0x1D622,97], // Sans Italic Cap/Small
    [0x1D63C,65],[0x1D656,97], // Sans Bold Italic Cap/Small
    [0x1D670,65],[0x1D68A,97], // Monospace Cap/Small
  ];
  var out = '';
  var i = 0;
  while (i < str.length) {
    var code = str.codePointAt(i);
    var adv = code > 0xFFFF ? 2 : 1;
    var mapped = false;
    for (var r = 0; r < MATH_RANGES.length; r++) {
      if (code >= MATH_RANGES[r][0] && code < MATH_RANGES[r][0] + 26) {
        out += String.fromCharCode(MATH_RANGES[r][1] + (code - MATH_RANGES[r][0]));
        mapped = true;
        break;
      }
    }
    if (!mapped) { for (var c = 0; c < adv; c++) out += str[i + c]; }
    i += adv;
  }
  return out;
}

// ─── Scanner ──────────────────────────────────────────────────────────────────
function extractTexts(node) {
  var texts = [];
  if (node.type === "TEXT") {
    var chars = safeProp(node, 'characters', '');
    if (chars) texts.push(chars);
  }
  if (node.children) {
    for (var i = 0; i < node.children.length; i++) {
      var sub = extractTexts(node.children[i]);
      for (var j = 0; j < sub.length; j++) texts.push(sub[j]);
    }
  }
  return arrFilter(texts, function(t) { return t.trim().length > 0; });
}

function getComponentName(node) {
  // Não acessamos mainComponent durante o scan — esse acesso resolve o componente
  // original, que pode estar em outra página ou biblioteca externa, forçando o Figma
  // a carregar outras páginas do arquivo. Para detecção de handoff cards, o nome do
  // próprio nó (node.name) já é suficiente, pois instâncias herdam o nome do componente.
  return "";
}

// Lê uma propriedade de nó Figma com segurança.
// O operador 'in' e typeof não funcionam em nós Figma (objetos proxy com getters lazy).
// Propriedades não suportadas pelo tipo do nó lançam exceção ao acessar.
function safeProp(node, prop, fallback) {
  try {
    var val = node[prop];
    return (val !== undefined && val !== null) ? val : fallback;
  } catch(e) {
    return fallback;
  }
}

// Lê propriedades de layout em um único try/catch por nó.
// Muito mais rápido que 12 safeProp individuais em arquivos grandes.
function readLayoutProps(node) {
  try {
    return {
      layoutMode:            node.layoutMode            || 'NONE',
      itemSpacing:           node.itemSpacing           || 0,
      paddingTop:            node.paddingTop            || 0,
      paddingBottom:         node.paddingBottom         || 0,
      paddingLeft:           node.paddingLeft           || 0,
      paddingRight:          node.paddingRight          || 0,
      primaryAxisAlignItems: node.primaryAxisAlignItems || 'MIN',
      counterAxisAlignItems: node.counterAxisAlignItems || 'MIN',
      x:      node.x      || 0,
      y:      node.y      || 0,
      width:  node.width  || 0,
      height: node.height || 0,
    };
  } catch(e) {
    return { layoutMode:'NONE', itemSpacing:0, paddingTop:0, paddingBottom:0,
             paddingLeft:0, paddingRight:0, primaryAxisAlignItems:'MIN',
             counterAxisAlignItems:'MIN', x:0, y:0, width:0, height:0 };
  }
}

// Profundidade máxima de scan recursivo.
// Cards de handoff ficam tipicamente nos primeiros 8 níveis (page → section →
// frame → grupo → card → texto). Nodes mais profundos são internos de componentes
// de UI e não contêm cards — escanear além disso só desperdiça tempo.
var MAX_SCAN_DEPTH = 8;

function scanNode(node, depth) {
  depth = depth === undefined ? 0 : depth;
  var layout = readLayoutProps(node);
  // exportSettingsCount: quantos presets de exportação o nó tem configurados.
  // Usado para detectar assets que ainda não foram preparados para exportação.
  var exportSettingsCount = 0;
  try { exportSettingsCount = (node.exportSettings && node.exportSettings.length) ? node.exportSettings.length : 0; } catch(e) {}
  var result = {
    id:                  node.id,
    name:                node.name || "",
    type:                node.type,
    componentName:       getComponentName(node),
    texts:               extractTexts(node),
    exportSettingsCount: exportSettingsCount,
    children:            [],
    layoutMode:            layout.layoutMode,
    itemSpacing:           layout.itemSpacing,
    paddingTop:            layout.paddingTop,
    paddingBottom:         layout.paddingBottom,
    paddingLeft:           layout.paddingLeft,
    paddingRight:          layout.paddingRight,
    primaryAxisAlignItems: layout.primaryAxisAlignItems,
    counterAxisAlignItems: layout.counterAxisAlignItems,
    x:      layout.x,
    y:      layout.y,
    width:  layout.width,
    height: layout.height,
  };
  // Limita profundidade: não desce em internos de componentes/grupos profundos
  if (node.children && depth < MAX_SCAN_DEPTH) {
    for (var i = 0; i < node.children.length; i++) {
      result.children.push(scanNode(node.children[i], depth + 1));
    }
  }
  return result;
}

function flattenNode(node) {
  var out = [node];
  if (node.children) {
    for (var i = 0; i < node.children.length; i++) {
      var sub = flattenNode(node.children[i]);
      for (var j = 0; j < sub.length; j++) out.push(sub[j]);
    }
  }
  return out;
}

function matchesNames(node, nameList) {
  var cn = node.componentName.toLowerCase();
  var nn = node.name.toLowerCase();
  return arrSome(nameList, function(n) {
    var nl = n.toLowerCase();
    return strIncludes(cn, nl) || strIncludes(nn, nl);
  });
}

// Listas pré-computadas uma vez (não a cada chamada de isHandoffNode)
var _ALL_COMPONENT_NAMES = (function() {
  var out = [];
  var keys = Object.keys(COMPONENT_NAMES);
  for (var k = 0; k < keys.length; k++) {
    var list = COMPONENT_NAMES[keys[k]];
    for (var i = 0; i < list.length; i++) out.push(list[i].toLowerCase());
  }
  return out;
})();

var _ALL_CARD_KEYWORDS = (function() {
  var out = [];
  var typeKeys = Object.keys(CARD_TYPE_KEYWORDS);
  for (var t = 0; t < typeKeys.length; t++) {
    var kws = CARD_TYPE_KEYWORDS[typeKeys[t]];
    for (var i = 0; i < kws.length; i++) out.push(kws[i]);
  }
  return out;
})();

// Mapa de todos os rótulos de tipo (de todos os tipos) para skip em extractTitle.
// Impede que "REGRA", "INSTRUÇÃO" etc. sejam confundidos com o título real do card.
var _ALL_TYPE_LABELS = (function() {
  var out = {};
  var typeKeys = Object.keys(CARD_TYPE_KEYWORDS);
  for (var t = 0; t < typeKeys.length; t++) {
    var kws = CARD_TYPE_KEYWORDS[typeKeys[t]];
    for (var i = 0; i < kws.length; i++) out[kws[i].toUpperCase()] = true;
    // Adiciona também o próprio nome do tipo (ex: "REGRA")
    out[typeKeys[t].toUpperCase()] = true;
  }
  // Labels extras usados em templates de cards como cabeçalho de seção
  var extras = ["INSTRUÇÃO","INSTRUCAO","INSTRUCTION","TITULO","TITLE",
                "DESCRIÇÃO","DESCRICAO","DESCRIPTION","TIPO","TYPE",
                "COMPORTAMENTO","BEHAVIOR","REFERENCIA","REFERÊNCIA"];
  for (var e = 0; e < extras.length; e++) out[extras[e]] = true;
  return out;
})();

function isHandoffNode(node) {
  var cn = node.componentName.toLowerCase();
  var nn = node.name.toLowerCase();
  for (var i = 0; i < _ALL_COMPONENT_NAMES.length; i++) {
    var nl = _ALL_COMPONENT_NAMES[i];
    if (cn.indexOf(nl) !== -1 || nn.indexOf(nl) !== -1) return true;
  }
  var full = node.texts.join(" ").toUpperCase();
  for (var j = 0; j < _ALL_CARD_KEYWORDS.length; j++) {
    if (full.indexOf(_ALL_CARD_KEYWORDS[j]) !== -1) return true;
  }
  return false;
}

function scan(scope) {
  var rootNodes = [];
  if (scope === "selection") {
    var sel = figma.currentPage.selection;
    rootNodes = sel.length ? Array.from(sel) : Array.from(figma.currentPage.children);
  } else if (scope === "section") {
    var sel2 = figma.currentPage.selection;
    if (sel2.length && (sel2[0].type === "SECTION" || sel2[0].type === "FRAME")) {
      rootNodes = [sel2[0]];
    } else {
      rootNodes = Array.from(figma.currentPage.children);
    }
  } else {
    rootNodes = Array.from(figma.currentPage.children);
  }

  var scanned = arrMap(rootNodes, function(n) { return scanNode(n); });
  var all = [];
  for (var i = 0; i < scanned.length; i++) {
    var flat = flattenNode(scanned[i]);
    for (var j = 0; j < flat.length; j++) all.push(flat[j]);
  }

  var handoff = arrFilter(all, isHandoffNode);

  // ── Deduplicação: remove sub-frames que são filhos de um card já detectado ──
  // Exemplo: o frame "Header" (que contém a chip "REGRA") não deve ser parseado
  // separadamente do card pai, pois o card pai já contém todos os textos.
  // Construímos um mapa de parentId para identificar a cadeia de ancestrais.
  var parentMap = {};
  function _buildParentMap(node, pid) {
    if (pid) parentMap[node.id] = pid;
    if (node.children) {
      for (var ci = 0; ci < node.children.length; ci++) {
        _buildParentMap(node.children[ci], node.id);
      }
    }
  }
  for (var si = 0; si < scanned.length; si++) _buildParentMap(scanned[si], null);

  var handoffIdSet = {};
  for (var hi = 0; hi < handoff.length; hi++) handoffIdSet[handoff[hi].id] = true;

  // Mantém apenas nodes cujo nenhum ancestral também seja handoff node
  handoff = arrFilter(handoff, function(node) {
    var pid = parentMap[node.id];
    while (pid) {
      if (handoffIdSet[pid]) return false; // ancestral já é card — este é sub-frame
      pid = parentMap[pid];
    }
    return true;
  });

  return { allFlat: all, handoffNodes: handoff, totalScanned: all.length, rootNodes: scanned };
}

// ─── Card Parser ──────────────────────────────────────────────────────────────
function detectCardType(node) {
  if (matchesNames(node, COMPONENT_NAMES.context))    return "CONTEXTO";
  if (matchesNames(node, COMPONENT_NAMES.rule))       return "REGRA";
  if (matchesNames(node, COMPONENT_NAMES.decision))   return "DECISÃO";
  if (matchesNames(node, COMPONENT_NAMES.state))      return "ESTADO";
  if (matchesNames(node, COMPONENT_NAMES.pending))    return "PENDÊNCIA";
  if (matchesNames(node, COMPONENT_NAMES.outOfScope)) return "FORA DE ESCOPO";
  var full = node.texts.join(" ").toUpperCase();
  var typeKeys = Object.keys(CARD_TYPE_KEYWORDS);
  for (var t = 0; t < typeKeys.length; t++) {
    var kws = CARD_TYPE_KEYWORDS[typeKeys[t]];
    if (arrSome(kws, function(k) { return strIncludes(full, k); })) return typeKeys[t];
  }
  return "UNKNOWN";
}

function extractMarker(texts) {
  for (var i = 0; i < texts.length; i++) {
    var tr = texts[i].trim();
    if (/^\d+$/.test(tr)) {
      var n = parseInt(tr, 10);
      if (n > 0 && n < 1000) return n;
    }
  }
  return null;
}

// Verifica se uma string (linha) é um rótulo de tipo a ser ignorado como título.
// Cobre: exato ("REGRA"), com pontuação ("REGRA:"), com prefixo numérico ("[2] REGRA", "2. REGRA").
function _isTypeLabel(line) {
  if (!line || line.length < 2) return false;
  var up = line.toUpperCase();
  if (_ALL_TYPE_LABELS[up]) return true;
  // Remove pontuação ao redor: "REGRA:" → "REGRA", "[INSTRUÇÃO]" → "INSTRUÇÃO"
  var stripped = up.replace(/^[\[\(→:\-\s]+|[\]\)→:\-\s.,]+$/g, '').trim();
  if (stripped && _ALL_TYPE_LABELS[stripped]) return true;
  // Remove prefixo numérico: "[2] REGRA" → "REGRA", "2. REGRA" → "REGRA"
  var noNum = up.replace(/^\[?\d+\]?[\s.\-→:]+/, '').trim();
  if (noNum && _ALL_TYPE_LABELS[noNum]) return true;
  return false;
}

function extractTitle(texts, type) {
  for (var i = 0; i < texts.length; i++) {
    var raw = texts[i];
    if (!raw) continue;
    // Quebrar por newline: text nodes multi-linha podem ter "REGRA\nTítulo real"
    var lines = raw.split(/\n+/);
    for (var li = 0; li < lines.length; li++) {
      var tr = lines[li].trim();
      if (!tr || tr.length < 3) continue;
      if (/^\d+$/.test(tr)) continue;
      // Ignorar qualquer variante de rótulo de tipo (REGRA, INSTRUÇÃO, [2] REGRA, REGRA:, etc.)
      if (_isTypeLabel(tr)) continue;
      return tr;
    }
  }
  return null;
}

function extractDescription(texts, title) {
  var best = null;
  for (var i = 0; i < texts.length; i++) {
    var t = texts[i].trim();
    if (t.length >= 15 && t !== title) {
      if (!best || t.length > best.length) best = t;
    }
  }
  return best;
}

function parseCard(node) {
  var type = detectCardType(node);
  if (type === "UNKNOWN") return null;
  var marker = extractMarker(node.texts);
  var title = extractTitle(node.texts, type);
  var description = extractDescription(node.texts, title);
  var full = node.texts.join(" ").toLowerCase();
  var ambiguous = [];
  for (var ai = 0; ai < AMBIGUOUS_TERMS.length; ai++) {
    if (full.indexOf(AMBIGUOUS_TERMS[ai]) !== -1) ambiguous.push(AMBIGUOUS_TERMS[ai]);
  }
  var hasTrigger = arrSome(TRIGGER_KW, function(k) { return strIncludes(full, k); });
  var hasResult  = arrSome(RESULT_KW,  function(k) { return strIncludes(full, k); });
  var hasOwner   = type === "PENDÊNCIA" ? arrSome(["owner","responsável","@","squad"], function(k) { return strIncludes(full, k); }) : null;
  return {
    nodeId: node.id, nodeName: node.name, type: type,
    marker: marker, title: title, description: description,
    hasTrigger: hasTrigger, hasResult: hasResult,
    hasOwner: hasOwner, ambiguous: ambiguous,
    isComplete: !!(title && description),
  };
}

function parseCards(handoffNodes) {
  var out = [];
  for (var i = 0; i < handoffNodes.length; i++) {
    if (matchesNames(handoffNodes[i], COMPONENT_NAMES.marker)) continue;
    var c = parseCard(handoffNodes[i]);
    if (c && c.type !== "UNKNOWN") out.push(c);
  }
  return out;
}

function parseMarkers(handoffNodes) {
  var out = [];
  for (var i = 0; i < handoffNodes.length; i++) {
    var n = handoffNodes[i];
    if (!matchesNames(n, COMPONENT_NAMES.marker)) continue;
    var num = extractMarker(n.texts);
    if (num !== null) out.push({ nodeId: n.id, nodeName: n.name, number: num });
  }
  return out;
}

// Detecta labels de caminho em textos CURTOS do card de decisão.
// Labels de caminho ("Sim", "Não", "→ Sucesso") são tipicamente nós de texto
// com ≤ 30 caracteres. Buscar no texto completo gera falsos positivos: "não" e
// "sim" aparecem em qualquer descrição em português ("Caso não encontre…").
function _hasDecisionLabel(texts, keywords) {
  for (var ti = 0; ti < texts.length; ti++) {
    var t = texts[ti].toLowerCase().trim();
    if (t.length > 30) continue; // texto longo = descrição, não label de caminho
    for (var ki = 0; ki < keywords.length; ki++) {
      if (strIncludes(t, keywords[ki])) return true;
    }
  }
  return false;
}

function parseDecisions(handoffNodes) {
  var out = [];
  for (var i = 0; i < handoffNodes.length; i++) {
    var n = handoffNodes[i];
    if (!matchesNames(n, COMPONENT_NAMES.decision)) {
      var full = n.texts.join(" ").toUpperCase();
      var decKws = CARD_TYPE_KEYWORDS["DECISÃO"];
      if (!arrSome(decKws, function(k) { return strIncludes(full, k); })) continue;
    }
    // Usa apenas textos curtos para detectar labels de caminho — evita falsos positivos
    var hasYes = _hasDecisionLabel(n.texts, DECISION_POS);
    var hasNo  = _hasDecisionLabel(n.texts, DECISION_NEG);
    var hasErr = _hasDecisionLabel(n.texts, DECISION_ERR);
    var question = arrFind(n.texts, function(t) { return strIncludes(t, "?"); });
    out.push({ nodeId: n.id, nodeName: n.name, question: question, hasYesPath: hasYes, hasNoPath: hasNo, hasErrorPath: hasErr, isComplete: hasYes && hasNo });
  }
  return out;
}

// ─── Validators ───────────────────────────────────────────────────────────────
// Padrões de nome que indicam frame de capa/cobertura do handoff.
// Esses frames (cover, task cover, handoff dev, etc.) funcionam como contexto
// mesmo sem um card formal de CONTEXTO — contêm título da feature e JTBD.
var COVER_FRAME_PATTERNS = [
  /\bcover\b/i,
  /task\s*cover/i,
  /handoff\s*(dev|design|cover)?/i,
  /capa\s*(do\s*)?(handoff|task|fluxo)?/i,
  /contexto\s*(do\s*)?(fluxo|handoff|task)?/i,
  /job\s*to\s*be\s*done/i,
  /\bjtbd\b/i,
  /brief\s*(do\s*)?(fluxo|task|handoff)?/i,
];

// Verifica se um nó escaneado (plain object) representa um cover frame.
// Considera: nome do frame E presença de texto substancial (título + descrição).
function _isCoverFrame(node) {
  var nm = node.name || '';
  var matchesName = arrSome(COVER_FRAME_PATTERNS, function(p) { return p.test(nm); });
  if (!matchesName) return false;
  // Exige ao menos um texto com mais de 20 chars — evita falsos positivos em frames vazios
  var hasSubstantialText = arrSome(node.texts || [], function(t) { return t.length > 20; });
  return hasSubstantialText;
}

function validateContext(cards, allFlat) {
  // 1. Tenta encontrar card formal de CONTEXTO
  var ctx = arrFind(cards, function(c) { return c.type === "CONTEXTO"; });
  if (ctx) {
    if (!ctx.description || ctx.description.length < 20) {
      return { issues: [mkIssue("high","context","Context card com descrição insuficiente","O card existe mas a descrição é muito curta.","Adicione objetivo, plataforma, status e referências.",ctx.nodeId)], strengths: [], score: 40 };
    }
    return { issues: [], strengths: [{ title: "Contexto da jornada documentado", description: "O handoff possui Context Card com descrição adequada.", nodeId: ctx.nodeId }], score: 100 };
  }

  // 2. Fallback: procura frame de capa (Cover, Task Cover, Handoff dev, etc.)
  // Esses frames representam contexto mesmo sem card formal.
  var coverFrame = arrFind(allFlat, function(n) { return _isCoverFrame(n); });
  if (coverFrame) {
    // Frame de capa encontrado — considerado contexto suficiente independente do tamanho do texto.
    return {
      issues: [],
      strengths: [{ title: "Contexto da jornada documentado", description: 'Frame de capa "' + coverFrame.name + '" encontrado com título e descrição da feature.', nodeId: coverFrame.id }],
      score: 100,
    };
  }

  // 3. Nenhum contexto encontrado
  return {
    issues: [mkIssue("critical","context","Context card ausente","Não foi encontrado card de contexto ou frame de capa (Cover, Task Cover, Handoff dev...). A Engenharia não sabe o objetivo desta entrega.","Adicione um Context Card ou frame de capa com título da feature, objetivo e JTBD.",null,true)],
    strengths: [], score: 0,
  };
}

function validateTraceability(cards, markers) {
  var issues = [], strengths = [];
  var cardNums = {};
  for (var i = 0; i < cards.length; i++) if (cards[i].marker) cardNums[cards[i].marker] = true;
  var markerNums = {};
  for (var i = 0; i < markers.length; i++) markerNums[markers[i].number] = true;
  for (var i = 0; i < markers.length; i++) {
    if (!cardNums[markers[i].number]) issues.push(mkIssue("high","traceability","Marcador " + markers[i].number + " sem card correspondente","Marcador visual existe mas não há card explicativo.","Crie um card para o marcador " + markers[i].number + ".",markers[i].nodeId,true));
  }
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].marker && !markerNums[cards[i].marker]) issues.push(mkIssue("medium","traceability","Card " + cards[i].marker + " sem marcador visual","Card numerado sem marcador correspondente na tela.","Adicione marcador " + cards[i].marker + " no elemento.",cards[i].nodeId));
  }
  if (!issues.length && markers.length > 0) strengths.push({ title: "Rastreabilidade completa", description: "Todos os marcadores têm cards correspondentes.", nodeId: markers[0] ? markers[0].nodeId : null });
  var penalty = 0;
  for (var i = 0; i < issues.length; i++) penalty += (issues[i].isCriticalBlocker ? 30 : 15);
  return { issues: issues, strengths: strengths, score: markers.length === 0 ? 50 : Math.max(0, 100 - penalty) };
}

function validateDecisions(decisions) {
  var issues = [], strengths = [];
  if (!decisions.length) return { issues: issues, strengths: strengths, score: 70 };
  for (var i = 0; i < decisions.length; i++) {
    var d = decisions[i];
    if (!d.hasYesPath && !d.hasNoPath) {
      issues.push(mkIssue("critical","decisions","Decisão sem caminhos definidos",'"' + d.nodeName + '" não tem caminho positivo nem negativo.',"Documente caminhos Sim/Não na descrição ou labels.",d.nodeId,true));
    } else if (!d.hasNoPath) {
      issues.push(mkIssue("critical","decisions","Decisão sem caminho negativo",'"' + d.nodeName + '" tem caminho positivo mas sem "Não" ou "Erro".',"Adicione o caminho negativo com destino e label.",d.nodeId,true));
    }
    if (!d.question) issues.push(mkIssue("medium","decisions","Decisão não formulada como pergunta",'"' + d.nodeName + '" não está escrito como pergunta.',"Reformule como pergunta (ex: Busca retornou resultados?).",d.nodeId));
  }
  var complete = arrFilter(decisions, function(d) { return d.isComplete; });
  if (complete.length === decisions.length) strengths.push({ title: "Decisões com caminhos completos", description: "Todas as decisões têm caminhos positivo e negativo.", nodeId: decisions[0] ? decisions[0].nodeId : null });
  var critCount = arrFilter(issues, function(i) { return i.isCriticalBlocker; }).length;
  var otherCount = arrFilter(issues, function(i) { return !i.isCriticalBlocker; }).length;
  return { issues: issues, strengths: strengths, score: Math.max(0, 100 - critCount * 40 - otherCount * 15) };
}

function validateStates(cards, allFlat, flowType, rootNodes) {
  var expected = FLOW_STATES[flowType] || [];
  var critical  = CRITICAL_STATES[flowType] || [];
  var issues = [], strengths = [];

  // Corpus global para saber quais estados existem em algum lugar no arquivo
  var globalCorpus = [];
  var stateCards = arrFilter(cards, function(c) { return c.type === "ESTADO"; });
  for (var i = 0; i < stateCards.length; i++) {
    globalCorpus.push(((stateCards[i].title || "") + " " + (stateCards[i].description || "")).toLowerCase());
  }
  for (var i = 0; i < allFlat.length; i++) globalCorpus.push(allFlat[i].name.toLowerCase());

  var found = [], missing = [];
  for (var s = 0; s < expected.length; s++) {
    var state = expected[s];
    var terms = arrFilter(state.toLowerCase().split(/[\s\/]/), function(t) { return t.length > 2; });
    var isFound = arrSome(terms, function(t) { return arrSome(globalCorpus, function(c) { return strIncludes(c, t); }); });
    (isFound ? found : missing).push(state);
  }

  // Sections válidas para checar estados: apenas containers que contêm telas de fluxo.
  // Exclui: sections de assets/ícones, frames soltos na raiz (ícones, componentes avulsos)
  // e frames que não têm dimensão de tela (mobile/web).
  var sections = arrFilter(rootNodes || [], function(n) {
    if (_isAssetSection(n)) return false;
    if (n.type === "SECTION") {
      // Section válida = contém ao menos um frame com dimensão de tela
      return arrSome(n.children || [], function(c) {
        return c.type === "FRAME" && isPageSizedFrame(c);
      });
    }
    if (n.type === "FRAME") {
      // Frame direto na raiz só entra se for tamanho de tela
      return isPageSizedFrame(n);
    }
    return false;
  });

  for (var mi = 0; mi < missing.length; mi++) {
    var state = missing[mi];
    var isCrit = includes(critical, state);
    var stateTerms = arrFilter(state.toLowerCase().split(/[\s\/]/), function(t) { return t.length > 2; });

    if (sections.length <= 1) {
      // Arquivo com uma única section ou sem sections: issue global
      issues.push(mkIssue(
        isCrit ? "high" : "medium", "states",
        "Estado ausente: " + state,
        '"' + state + '" é esperado para fluxo "' + flowType + '" mas não foi encontrado.',
        'Adicione um frame ou State Card para o estado "' + state + '".',
        sections.length === 1 ? sections[0].id : null
      ));
    } else {
      // Múltiplas sections: cria uma issue por section que NÃO contém o estado.
      // O designer vê exatamente qual tela está faltando e navega direto até ela.
      var flaggedAny = false;
      for (var si = 0; si < sections.length; si++) {
        var sec = sections[si];
        var secFlat = flattenNode(sec);
        var secCorpus = arrMap(secFlat, function(n) { return n.name.toLowerCase(); });
        var foundInSection = arrSome(stateTerms, function(t) {
          return arrSome(secCorpus, function(c) { return strIncludes(c, t); });
        });
        if (!foundInSection) {
          issues.push(mkIssue(
            isCrit ? "high" : "medium", "states",
            '"' + sec.name + '" — Estado ausente: ' + state,
            'A section "' + sec.name + '" não contém a tela "' + state + '", esperada para o fluxo "' + flowType + '".',
            'Adicione um frame ou State Card para "' + state + '" dentro da section "' + sec.name + '".',
            sec.id
          ));
          flaggedAny = true;
        }
      }
      // Se não foi possível vincular a nenhuma section específica, cria issue global
      if (!flaggedAny) {
        issues.push(mkIssue(
          isCrit ? "high" : "medium", "states",
          "Estado ausente: " + state,
          '"' + state + '" é esperado mas não foi encontrado em nenhuma section.',
          'Adicione um frame ou State Card para o estado "' + state + '".',
          null
        ));
      }
    }
  }

  var strengths = (!missing.length && expected.length)
    ? [{ title: "Estados mínimos cobertos", description: 'Todos os estados para "' + flowType + '" foram documentados.', nodeId: stateCards.length ? stateCards[0].nodeId : null }]
    : [];

  return {
    issues: issues,
    strengths: strengths,
    score: expected.length ? Math.round(found.length / expected.length * 100) : 100,
    coverage: { expected: expected, found: found, missing: missing },
  };
}

function validateCardQuality(cards) {
  var issues = [], strengths = [];
  var pts = 0, total = 0;
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    total += 3;
    var label = "[" + (c.marker || "?") + "] " + c.type + (c.title ? " — " + c.title : "");
    if (!c.title) issues.push(mkIssue("high","behaviors","Título ausente — card " + c.type,'"' + c.nodeName + '": o texto abaixo da tag de tipo não foi identificado como título. Verifique se há um título descritivo no card.',"Adicione um título que represente o comportamento documentado neste card.",c.nodeId));
    if (!c.description || c.description.length < 15) issues.push(mkIssue("high","behaviors","Card sem descrição: " + label,'"' + c.nodeName + '" sem descrição ou muito curta.',"Descreva com gatilho, contexto e resultado esperado.",c.nodeId));
    if (c.ambiguous && c.ambiguous.length && c.type !== "PENDÊNCIA") {
      // agrupar termos encontrados por categoria para recomendação específica
      var byCategory = {};
      for (var ai = 0; ai < c.ambiguous.length; ai++) {
        var cat = getAmbiguousCategory(c.ambiguous[ai]);
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(c.ambiguous[ai]);
      }
      var catKeys = Object.keys(byCategory);
      for (var ci = 0; ci < catKeys.length; ci++) {
        var cat = catKeys[ci];
        // "unnamed_dependency" removido: termos como "o back", "o time" são
        // comuns em handoffs e geram mais ruído do que valor acionável.
        if (cat === 'unnamed_dependency') continue;
        var catTerms = byCategory[cat];
        var catLabels = {
          indefinition:    "Decisão em aberto",
          vague_reference: "Referência vaga",
          deferral:        "Decisão postergada",
        };
        issues.push(mkIssue(
          "medium", "behaviors",
          (catLabels[cat] || "Ambiguidade") + " em: " + label,
          'Termos que impedem implementação direta: "' + catTerms.join('", "') + '".',
          AMBIGUOUS_RECOMMENDATIONS[cat] || "Remova a ambiguidade ou converta em PENDÊNCIA com owner.",
          c.nodeId
        ));
      }
    }
    if (c.type === "PENDÊNCIA" && c.hasOwner === false) issues.push(mkIssue("high","behaviors","Pendência sem owner: " + label,'"' + c.nodeName + '" sem responsável definido.',"Adicione owner da pendência.",c.nodeId));
    if (c.title) { pts++; if (c.hasTrigger) pts++; if (c.hasResult) pts++; }
  }
  var ruleCards = arrFilter(cards, function(c) { return c.type === "REGRA"; });
  var goodCards = arrFilter(ruleCards, function(c) { return c.isComplete && c.hasTrigger && c.hasResult; });
  if (ruleCards.length && goodCards.length >= ruleCards.length * 0.7) strengths.push({ title: "Descrições comportamentais implementáveis", description: "A maioria dos cards de regra tem gatilho e resultado esperado.", nodeId: goodCards[0] ? goodCards[0].nodeId : null });
  return { issues: issues, strengths: strengths, score: total > 0 ? Math.min(100, Math.round(pts / total * 100)) : 50 };
}

function validateStructure(cards, allFlat) {
  var issues = [], strengths = [];
  var score = 100;
  var frames = arrFilter(allFlat, function(n) { return n.type === "FRAME" || n.type === "SECTION"; });
  if (frames.length < 2) {
    issues.push(mkIssue("high","structure","Poucos frames detectados","Fluxo pode não estar estruturado visualmente.","Organize em frames/sections nomeados."));
    score -= 30;
  }
  var pendNoOwner = arrFilter(cards, function(c) { return c.type === "PENDÊNCIA" && c.hasOwner === false; });
  if (pendNoOwner.length) {
    issues.push(mkIssue("high","structure", pendNoOwner.length + " pendência(s) sem owner","Pendências sem responsável podem bloquear handoff.","Defina owner de cada pendência.", pendNoOwner[0].nodeId, true));
    score -= 20;
  }
  if (score >= 90) strengths.push({ title: "Estrutura do fluxo organizada", description: "Frames, escopo e pendências sob controle." });
  return { issues: issues, strengths: strengths, score: Math.max(0, score) };
}

// ─── Validator: Organização em Sections ──────────────────────────────────────
// Verifica se decisões e cenários de uso estão dentro de Sections do Figma,
// não soltos na página raiz, que dificulta a navegação da Engenharia.

var SECTION_HANDOFF_NAMES = [
  /decis/i, /fluxo/i, /flow/i, /handoff/i,
  /caso.*uso/i, /use.?case/i, /cenário/i, /scenario/i,
  /estado/i, /state/i, /contexto/i, /context/i,
  /regra/i, /rule/i, /especif/i, /spec/i,
];

function validateOrganization(rootNodes, handoffNodes) {
  var issues = [], strengths = [];
  var score = 100;

  // Sections no nível raiz da página
  var sections = arrFilter(rootNodes, function(n) { return n.type === "SECTION"; });

  if (sections.length === 0) {
    // Nenhuma section — tudo solto na página
    issues.push(mkIssue(
      "high", "organization",
      "Handoff sem organização em Sections",
      "Nenhuma Section do Figma foi encontrada. Decisões, cenários e cards soltos na página dificultam a navegação da Engenharia.",
      "Organize o conteúdo em Sections do Figma (ex: 'Contexto', 'Fluxo de Decisão', 'Casos de Uso', 'Estados de Erro').",
      rootNodes.length ? rootNodes[0].id : null
    ));
    score -= 50;
  } else {
    // Há sections — mas têm nomes adequados para handoff?
    var namedSections = arrFilter(sections, function(s) {
      var nm = s.name;
      return arrSome(SECTION_HANDOFF_NAMES, function(p) { return p.test(nm); });
    });

    if (namedSections.length === 0) {
      issues.push(mkIssue(
        "medium", "organization",
        "Sections sem nomenclatura de handoff",
        "Há Sections mas nenhuma está nomeada para organizar Decisões, Casos de Uso ou Estados — o time de desenvolvimento não consegue navegar com clareza.",
        "Nomeie as Sections de forma descritiva: 'Fluxo de Decisão', 'Casos de Uso', 'Estados de Erro', 'Contexto'.",
        sections[0].id
      ));
      score -= 25;
    }

    // Cards de handoff flutuando fora de qualquer section
    var floatingCards = arrFilter(rootNodes, function(n) {
      return n.type === "FRAME" && isHandoffNode(n);
    });

    if (floatingCards.length > 0) {
      for (var fi = 0; fi < floatingCards.length; fi++) {
        issues.push(mkIssue(
          "high", "organization",
          'Card fora de Section: "' + floatingCards[fi].name + '"',
          'Card de handoff encontrado diretamente na página raiz, fora de qualquer Section.',
          'Mova este card para a Section correspondente ao seu conteúdo (Decisão, Estado, Contexto, etc.).',
          floatingCards[fi].id
        ));
      }
      score -= Math.min(30, floatingCards.length * 10);
    }

    // Frames soltos na raiz que não são sections, não são assets reconhecidos
    // e não têm dimensão de tela — ícones avulsos, componentes soltos, etc.
    var looseFrames = arrFilter(rootNodes, function(n) {
      if (n.type === "SECTION") return false;                  // é uma section — ok
      if (_isAssetSection(n)) return false;                    // section de assets — ok
      if (isHandoffNode(n)) return false;                      // já capturado acima
      if (n.type === "FRAME" && isPageSizedFrame(n)) return false; // tela válida — ok
      return n.type === "FRAME" || n.type === "GROUP" ||
             n.type === "COMPONENT" || n.type === "INSTANCE";
    });

    if (looseFrames.length > 0) {
      var looseNames = arrMap(looseFrames.slice(0, 3), function(f) { return '"' + f.name + '"'; }).join(', ');
      var looseExtra = looseFrames.length > 3 ? ' e mais ' + (looseFrames.length - 3) + '...' : '';
      issues.push(mkIssue(
        "low", "organization",
        looseFrames.length + " frame(s) solto(s) na página",
        'Frames soltos encontrados fora de qualquer Section: ' + looseNames + looseExtra + '. Isso polui a página e pode confundir a Engenharia ao navegar no arquivo.',
        'Mova os frames soltos para dentro de uma Section ou para uma página separada de assets.',
        looseFrames[0].id
      ));
      score -= Math.min(15, looseFrames.length * 3);
    }
  }

  if (!issues.length) {
    strengths.push({
      title: "Handoff organizado em Sections",
      description: "O conteúdo está estruturado em Sections nomeadas, facilitando a navegação da Engenharia.",
      nodeId: sections.length ? sections[0].id : null,
    });
  }

  return { issues: issues, strengths: strengths, score: Math.max(0, score) };
}

// ─── Validator: Estrutura de páginas do arquivo ──────────────────────────────
// Verifica se a página atual de handoff vem depois de "ENTREGAR" e "📂 Fluxos"
// na sequência correta de páginas do arquivo Figma.
var _PAGE_ENTREGAR_RE = /\bentregar\b/i;
var _PAGE_FLUXOS_RE   = /\bfluxos?\b/i;

function validatePageStructure() {
  var issues = [], score = 100;

  var pages      = figma.root.children; // PageNode[], em ordem do painel
  var currentId  = figma.currentPage.id;
  var currentIdx  = -1;
  var entregarIdx = -1;
  var fluxosIdx   = -1;

  for (var i = 0; i < pages.length; i++) {
    var norm = _normalizeName(pages[i].name);
    if (entregarIdx === -1 && _PAGE_ENTREGAR_RE.test(norm)) entregarIdx = i;
    if (fluxosIdx   === -1 && _PAGE_FLUXOS_RE.test(norm))   fluxosIdx   = i;
    if (pages[i].id === currentId) currentIdx = i;
  }

  // Página "ENTREGAR" ausente
  if (entregarIdx === -1) {
    issues.push(mkIssue('medium', 'organization',
      'Página "ENTREGAR" não encontrada no arquivo',
      'Não há uma página de entrada chamada "ENTREGAR" antes do handoff. Essa página funciona como sumário e ponto de partida para a Engenharia navegar no arquivo.',
      'Crie uma página "ENTREGAR" (pode usar a formatação bold: 𝙀𝙉𝙏𝙍𝙀𝙂𝘼𝙍) e posicione-a como primeira página.',
      null
    ));
    score -= 25;
  }

  // Página "📂 Fluxos" ausente
  if (fluxosIdx === -1) {
    issues.push(mkIssue('medium', 'organization',
      'Página "📂 Fluxos" não encontrada no arquivo',
      'Não há uma página de fluxos (wireflows, userflows, sitemaps) antes do handoff. Essa página contextualiza os caminhos do produto para o time de Engenharia.',
      'Crie uma página "📂 Fluxos" posicionada após "ENTREGAR" e antes das páginas de handoff.',
      null
    ));
    score -= 25;
  }

  // Ambas existem — verificar ordem entre elas
  if (entregarIdx !== -1 && fluxosIdx !== -1 && entregarIdx > fluxosIdx) {
    issues.push(mkIssue('low', 'organization',
      'Ordem das páginas incorreta: "ENTREGAR" deve vir antes de "📂 Fluxos"',
      'As páginas de referência existem mas estão fora de ordem no arquivo. A convenção é: ENTREGAR → 📂 Fluxos → páginas de handoff.',
      'Reordene as páginas no painel do Figma: "ENTREGAR" primeiro, depois "📂 Fluxos".',
      null
    ));
    score -= 10;
  }

  // Handoff posicionado antes das páginas de referência
  if (currentIdx !== -1 && entregarIdx !== -1 && currentIdx <= entregarIdx) {
    issues.push(mkIssue('low', 'organization',
      'Handoff posicionado antes da página "ENTREGAR"',
      'A página de handoff atual aparece antes de "ENTREGAR" no arquivo. A Engenharia espera encontrar o handoff após as páginas de referência.',
      'Mova esta página para depois de "📂 Fluxos" no painel de páginas do Figma.',
      null
    ));
    score -= 10;
  }

  return { issues: issues, score: Math.max(0, score) };
}

// ─── Padrões de sections de assets/ícones ────────────────────────────────────
// Sections com esses nomes são bibliotecas de assets para exportação —
// não devem ser avaliadas por regras de estados de fluxo ou organização de handoff.
var ASSET_SECTION_PATTERNS = [
  /ícones?/i, /icones?/i, /\bicons?\b/i,
  /assets?/i,
  /novos?\s*ícones?/i, /novos?\s*icones?/i,
  /ilustra/i,          // ilustrações
  /sprite/i,
  /biblioteca\s*(de\s*)?(ícones?|icones?|componentes?|assets?)/i,
  /component\s*library/i,
  /design\s*tokens?/i,
  /exporta/i,          // "para exportar", "exportação"
];

function _isAssetSection(node) {
  return arrSome(ASSET_SECTION_PATTERNS, function(p) { return p.test(node.name || ''); });
}

// ─── Validator: Assets prontos para exportação ────────────────────────────────
// Verifica se sections de ícones/assets têm presets de exportação configurados.
// Nodes sem exportSettings não podem ser exportados diretamente pelo dev.

function validateAssets(rootNodes) {
  var issues = [], strengths = [];

  var assetSections = arrFilter(rootNodes || [], function(n) {
    return _isAssetSection(n);
  });

  if (assetSections.length === 0) {
    // Sem sections de assets detectadas — validação não se aplica
    return { issues: issues, strengths: strengths, score: 100 };
  }

  var totalAssets   = 0;
  var readyAssets   = 0;
  var notReadyNodes = [];

  for (var si = 0; si < assetSections.length; si++) {
    var sec = assetSections[si];
    var children = sec.children || [];
    // Filtra apenas frames/componentes diretos — ignora grupos puramente organizacionais
    var exportable = arrFilter(children, function(c) {
      return c.type === "FRAME" || c.type === "COMPONENT" || c.type === "INSTANCE" || c.type === "GROUP";
    });

    for (var ci = 0; ci < exportable.length; ci++) {
      totalAssets++;
      if (exportable[ci].exportSettingsCount > 0) {
        readyAssets++;
      } else {
        notReadyNodes.push({ name: exportable[ci].name, id: exportable[ci].id, section: sec.name, sectionId: sec.id });
      }
    }
  }

  if (totalAssets === 0) {
    return { issues: issues, strengths: strengths, score: 100 };
  }

  var pct = Math.round(readyAssets / totalAssets * 100);

  if (notReadyNodes.length > 0) {
    // Agrupa por section para não criar uma issue por ícone (pode ser dezenas)
    var bySec = {};
    for (var ni = 0; ni < notReadyNodes.length; ni++) {
      var key = notReadyNodes[ni].sectionId;
      if (!bySec[key]) bySec[key] = { name: notReadyNodes[ni].section, id: notReadyNodes[ni].sectionId, count: 0 };
      bySec[key].count++;
    }
    var secKeys = Object.keys(bySec);
    for (var ki = 0; ki < secKeys.length; ki++) {
      var s = bySec[secKeys[ki]];
      issues.push(mkIssue(
        "medium", "specs",
        'Assets sem preset de exportação: "' + s.name + '"',
        s.count + ' asset(s) em "' + s.name + '" não têm preset de exportação configurado. O dev não consegue exportar diretamente pelo Figma.',
        'Selecione os frames/ícones em "' + s.name + '", abra o painel "Design" → "Export" e adicione o preset (SVG, PNG 1× 2× 3×, etc.).',
        s.id
      ));
    }
  }

  if (readyAssets === totalAssets) {
    strengths.push({
      title: "Assets prontos para exportação",
      description: 'Todos os ' + totalAssets + ' assets têm preset de exportação configurado.',
      nodeId: assetSections[0].id,
    });
  }

  return { issues: issues, strengths: strengths, score: pct };
}

// ─── Validator: Specs de espaçamento ─────────────────────────────────────────
// Verifica se o arquivo contém anotações de espaçamento ou referências a tokens
// que a Engenharia possa usar para saber quais tokens de spacing aplicar.

var SPECS_FRAME_PATTERNS = [
  /\bspecs?\b/i, /especifica/i, /annotation/i, /anotaç/i, /redline/i,
  /red.?line/i, /medidas/i, /spacing/i, /espaçamento/i, /measurement/i,
  /tokens?\s*de\s*espaç/i, /spacing.?token/i,
];

var SPACING_TOKEN_PATTERNS = [
  /spacing[-_\/]\w/i,       // spacing-sm, spacing/4, spacing_md
  /space[-_\/]\w/i,         // space-4, space/sm
  /sp[-_]\d/i,              // sp-4, sp-8
  /gap\s*[:=]\s*\d/i,       // gap: 8, gap=16
  /padding\s*[:=]\s*\d/i,   // padding: 16
  /\d+\s*dp\b/i,            // 16dp
  /\btoken\s*:/i,           // token: spacing-md
  /\bds[-_]\w/i,            // ds-spacing-sm (design system prefix)
  /\b(xs|sm|md|lg|xl)\s*=\s*\d/i, // sm = 8px
];

function validateSpecs(allFlat) {
  var issues = [], strengths = [];
  var score = 100;

  // 1. Procura frames/sections explicitamente nomeados como specs
  var specFrames = arrFilter(allFlat, function(n) {
    if (n.type === "TEXT") return false;
    return arrSome(SPECS_FRAME_PATTERNS, function(p) { return p.test(n.name); });
  });

  // 2. Procura textos curtos (< 40 chars) contendo padrões de token de espaçamento
  // Textos curtos = anotações; textos longos = descrições (falso positivo)
  var specTexts = arrFilter(allFlat, function(n) {
    if (!n.texts || !n.texts.length) return false;
    return arrSome(n.texts, function(t) {
      if (t.length > 60) return false; // texto longo não é anotação de spacing
      return arrSome(SPACING_TOKEN_PATTERNS, function(p) { return p.test(t); });
    });
  });

  var hasSpecs = specFrames.length > 0 || specTexts.length > 0;

  if (!hasSpecs) {
    issues.push(mkIssue(
      "medium", "specs",
      "Specs de espaçamento ausentes",
      "Não foram encontradas anotações ou tokens de espaçamento. A Engenharia não tem referência de quais design tokens aplicar.",
      "Adicione um frame 'Specs' indicando tokens de espaçamento por componente (ex: spacing-sm = 8px, spacing-md = 16px). Use anotações ou um frame dedicado.",
      allFlat.length ? allFlat[0].id : null
    ));
    score -= 50;
  } else if (specFrames.length === 0 && specTexts.length < 3) {
    // Há algo, mas é esparso — não está sistematizado
    issues.push(mkIssue(
      "low", "specs",
      "Specs de espaçamento incompletas",
      "Foram encontradas poucas referências a tokens de espaçamento. A cobertura pode não ser suficiente para todos os componentes do fluxo.",
      "Consolide as specs em um frame dedicado, cobrindo gaps, paddings e margens de cada componente ou seção do fluxo.",
      specTexts.length ? specTexts[0].id : null
    ));
    score -= 20;
  }

  if (!issues.length || score >= 80) {
    strengths.push({
      title: "Specs de espaçamento documentadas",
      description: "O handoff inclui referências a tokens de espaçamento para a Engenharia.",
      nodeId: specFrames.length ? specFrames[0].id : (specTexts.length ? specTexts[0].id : null),
    });
  }

  return { issues: issues, strengths: strengths, score: Math.max(0, score) };
}

// ─── Validator: Layout de telas (auto layout + espaçamento 32px) ──────────────
// Avalia cada FRAME raiz: usa auto layout? gap entre seções filhas é 32px?
// Retorna score por tela e issues navegáveis.

var SECTION_GAP_EXPECTED = 32; // px — espaçamento canônico entre blocos
var SECTION_GAP_TOLERANCE = 4; // aceita 28–36px

// Larguras padrão de telas de interface (mobile, tablet, web) com tolerância ±30px.
// Frames fora dessas dimensões são componentes/overlays (modais, bottom sheets,
// date pickers, telas de loading como componente, etc.) e não são avaliados.
var PAGE_WIDTHS = [320, 360, 375, 390, 393, 414, 428, 768, 1024, 1280, 1366, 1440, 1920];
var PAGE_WIDTH_TOLERANCE = 30;
var PAGE_MIN_HEIGHT = 600; // abaixo disso é overlay/componente, não tela completa

function isPageSizedFrame(frame) {
  var w = frame.width;
  var h = frame.height;
  if (h < PAGE_MIN_HEIGHT) return false;
  for (var i = 0; i < PAGE_WIDTHS.length; i++) {
    if (Math.abs(w - PAGE_WIDTHS[i]) <= PAGE_WIDTH_TOLERANCE) return true;
  }
  return false;
}

// Nomes de frames que representam overlays/componentes flutuantes — não devem
// entrar na comparação de gap entre seções de uma tela.
var OVERLAY_NAME_PATTERNS = [
  /date.?picker/i, /datepicker/i,
  /snackbar/i, /toast/i,
  /modal/i, /dialog/i, /dialogue/i,
  /bottom.?sheet/i,
  /tooltip/i, /popover/i, /dropdown/i,
  /loading/i, /loader/i, /spinner/i,
  /overlay/i, /backdrop/i,
  /alert/i, /banner/i,
  /notification/i,
  /drawer/i, /side.?bar/i,
  /fab$/i,  // Floating Action Button
  /\bpicker\b/i,
];

function isOverlayComponent(node) {
  var name = node.name || '';
  for (var i = 0; i < OVERLAY_NAME_PATTERNS.length; i++) {
    if (OVERLAY_NAME_PATTERNS[i].test(name)) return true;
  }
  return false;
}

function validateScreenLayout(rootNodes) {
  var issues = [], strengths = [];
  var screenScores = [];

  if (!rootNodes || !rootNodes.length) {
    return { issues: issues, strengths: strengths, score: 50, screenScores: [] };
  }

  // rootNodes são os frames de primeiro nível (telas)
  var frames = arrFilter(rootNodes, function(n) {
    return n.type === "FRAME" || n.type === "SECTION";
  });

  if (frames.length === 0) {
    return { issues: issues, strengths: strengths, score: 50, screenScores: [] };
  }

  var totalScore = 0;
  var analyzedCount = 0; // conta apenas frames efetivamente avaliados

  for (var fi = 0; fi < frames.length; fi++) {
    var frame = frames[fi];
    var frameScore = 100;
    var frameIssues = [];

    // Sections do Figma são containers organizacionais — não suportam auto layout.
    // Apenas FRAME nodes devem ser avaliados para presença de auto layout.
    var isSection = frame.type === "SECTION";

    // Frames que não correspondem a dimensões padrão de telas (mobile/web) são
    // componentes/overlays: modais, bottom sheets, date pickers, loading states, etc.
    // Esses não devem ser avaliados por critérios de layout de tela.
    if (!isSection && !isPageSizedFrame(frame)) continue;

    // 1. Usa auto layout? (não aplicável a Sections)
    var hasAutoLayout = frame.layoutMode === "HORIZONTAL" || frame.layoutMode === "VERTICAL";

    if (!hasAutoLayout && !isSection) {
      frameScore -= 40;
      frameIssues.push(mkIssue(
        "high", "structure",
        'Tela sem auto layout: "' + frame.name + '"',
        'O frame "' + frame.name + '" não usa auto layout. Elementos podem estar posicionados manualmente, dificultando a handoff.',
        'Ative auto layout no frame e defina o espaçamento entre seções como ' + SECTION_GAP_EXPECTED + 'px.',
        frame.id
      ));
    }

    // 2. Verifica gap entre seções filhas (children diretos significativos)
    // Exclui overlays/componentes flutuantes (date picker, snackbar, modal, etc.)
    // que ficam posicionados sobre a tela e não são seções de layout.
    var significantChildren = arrFilter(frame.children, function(c) {
      return (c.type === "FRAME" || c.type === "GROUP" || c.type === "INSTANCE" || c.type === "COMPONENT") &&
             c.height > 8 && c.width > 8 &&
             !isOverlayComponent(c);
    });

    // Sections que NÃO contêm telas mobile/web entre seus filhos são containers de
    // design system / biblioteca de componentes — não devem ser avaliadas por
    // regras de espaçamento de fluxo. Exemplo: grid de ícones, tokens, assets.
    if (isSection) {
      var hasFlowChildren = arrSome(significantChildren, function(c) {
        return c.type === "FRAME" && isPageSizedFrame(c);
      });
      if (!hasFlowChildren) continue;
    }

    if (hasAutoLayout && frame.layoutMode === "VERTICAL") {
      // Auto layout vertical: verifica itemSpacing
      var gap = frame.itemSpacing;
      var gapOk = Math.abs(gap - SECTION_GAP_EXPECTED) <= SECTION_GAP_TOLERANCE;
      if (!gapOk && significantChildren.length > 1) {
        frameScore -= 30;
        // Aponta ao segundo filho (quem recebe o gap errado) — mais específico que o frame pai
        var gapTargetId = significantChildren.length >= 2 ? significantChildren[1].id : significantChildren[0].id;
        frameIssues.push(mkIssue(
          "medium", "structure",
          'Espaçamento incorreto em "' + frame.name + '"',
          'Gap entre seções é ' + gap + 'px. O padrão esperado é ' + SECTION_GAP_EXPECTED + 'px (tolerância: ±' + SECTION_GAP_TOLERANCE + 'px).',
          'Selecione o frame "' + (significantChildren[1] ? significantChildren[1].name : frame.name) + '" e ajuste o "Gap between items" do auto layout para ' + SECTION_GAP_EXPECTED + 'px.',
          gapTargetId
        ));
      }
    } else if (!hasAutoLayout && significantChildren.length > 1) {
      // Sem auto layout: calcula gaps reais medindo distância entre children por y.
      // Cria UMA issue por gap incorreto, apontando ao child frame deslocado —
      // assim o designer tem um nodeId acionável para navegar diretamente ao problema.
      var sorted = significantChildren.slice().sort(function(a, b) { return a.y - b.y; });
      var wrongCount = 0;
      for (var ci = 0; ci < sorted.length - 1; ci++) {
        var gap = sorted[ci + 1].y - (sorted[ci].y + sorted[ci].height);
        if (gap < 0) continue; // sobrepostos — ignora
        var gapOk = Math.abs(gap - SECTION_GAP_EXPECTED) <= SECTION_GAP_TOLERANCE;
        if (!gapOk) {
          wrongCount++;
          var childName = sorted[ci + 1].name || ('Elemento ' + (ci + 2));
          var prevName  = sorted[ci].name     || ('Elemento ' + (ci + 1));
          var gapReal   = Math.round(gap);
          // Recomendação diferente para Section (sem auto layout) vs Frame (pode ativar)
          var recText = isSection
            ? 'Selecione "' + childName + '" e ajuste sua posição Y para que o gap com "' + prevName + '" seja ' + SECTION_GAP_EXPECTED + 'px (atual: ' + gapReal + 'px).'
            : 'Selecione "' + childName + '" e ajuste o espaçamento para ' + SECTION_GAP_EXPECTED + 'px — ou ative auto layout no frame "' + frame.name + '" para controlar o gap automaticamente.';
          frameIssues.push(mkIssue(
            "medium", "structure",
            'Espaçamento incorreto antes de "' + childName + '"',
            'Gap entre "' + prevName + '" e "' + childName + '": ' + gapReal + 'px. Esperado: ' + SECTION_GAP_EXPECTED + 'px (tolerância ±' + SECTION_GAP_TOLERANCE + 'px).',
            recText,
            sorted[ci + 1].id  // aponta ao child frame deslocado — navegável no Figma
          ));
        }
      }
      if (wrongCount > 0) {
        frameScore -= Math.min(20, wrongCount * 10); // penalidade proporcional, cap 20
      }
    }

    // 3. Tem filhos estruturais? (tela não vazia)
    if (significantChildren.length === 0 && frame.height > 100) {
      frameScore -= 20;
      frameIssues.push(mkIssue(
        "low", "structure",
        'Tela possivelmente vazia: "' + frame.name + '"',
        'O frame "' + frame.name + '" não tem seções filhas detectáveis.',
        'Verifique se o conteúdo está agrupado em frames filhos ou adicione estrutura interna.',
        frame.id
      ));
    }

    frameScore = Math.max(0, frameScore);
    totalScore += frameScore;
    analyzedCount++;

    for (var ii = 0; ii < frameIssues.length; ii++) issues.push(frameIssues[ii]);

    screenScores.push({
      frameId:   frame.id,
      frameName: frame.name,
      nodeType:  frame.type,
      score:     frameScore,
      hasAutoLayout: hasAutoLayout,
      gap:       hasAutoLayout ? frame.itemSpacing : null,
      issueCount: frameIssues.length,
    });
  }

  // Ordena por score crescente — telas mais críticas primeiro
  screenScores.sort(function(a, b) { return a.score - b.score; });

  // avgScore usa apenas frames efetivamente avaliados (exclui componentes/overlays ignorados)
  var avgScore = analyzedCount > 0 ? Math.round(totalScore / analyzedCount) : 100;
  var perfectFrames = arrFilter(screenScores, function(s) { return s.score === 100; });

  if (analyzedCount > 0 && perfectFrames.length === analyzedCount) {
    strengths.push({
      title: "Todas as telas com auto layout e espaçamento correto",
      description: "Todos os frames usam auto layout com gap de " + SECTION_GAP_EXPECTED + "px entre seções.",
      nodeId: perfectFrames[0] ? perfectFrames[0].frameId : null,
    });
  } else if (perfectFrames.length > 0) {
    strengths.push({
      title: perfectFrames.length + " tela(s) com layout correto",
      description: perfectFrames.map(function(s) { return '"' + s.frameName + '"'; }).slice(0,3).join(", ") + " estão com auto layout e espaçamento ok.",
      nodeId: perfectFrames[0] ? perfectFrames[0].frameId : null,
    });
  }

  return { issues: issues, strengths: strengths, score: avgScore, screenScores: screenScores };
}

// ─── Validator: Critérios concretos em cards de VALIDAÇÃO (guardrail #2) ──────
// Um card de VALIDAÇÃO precisa mencionar ao menos um critério implementável:
// mínimo/máximo de chars, formato, máscara, mensagem de erro concreta.

var CONCRETE_KW = [
  // Limites numéricos
  "mínimo", "máximo", "min ", "max ", "até ", "pelo menos",
  "no mínimo", "no máximo", "entre ", "de ", " a ",
  // Formato / padrão
  "formato", "máscara", "padrão", "pattern", "regex",
  "somente números", "apenas números", "somente letras", "apenas letras",
  "alfanumérico", "cpf", "cnpj", "e-mail", "email", "telefone", "cep", "data",
  // Mensagem de erro concreta (texto entre aspas ou após ":")
  "mensagem:", "erro:", "exibir:", "mostrar:", "ex:", "exemplo:",
  '"', "'",
  // Critério de obrigatoriedade com detalhe
  "obrigatório quando", "obrigatório se", "opcional quando",
  "requerido quando", "required when",
];

function validateConcreteValidations(cards) {
  var issues = [], strengths = [];
  var validationCards = arrFilter(cards, function(c) {
    return c.type === "VALIDAÇÃO" || c.type === "REGRA";
  });

  // Só analisar cards que claramente tratam de validação de campo no título/desc
  var FIELD_KW = ["campo", "field", "input", "formulário", "form", "obrigatório",
                  "validar", "validação", "formato", "limite", "caractere"];

  var relevant = arrFilter(validationCards, function(c) {
    var text = ((c.title || "") + " " + (c.description || "")).toLowerCase();
    return arrSome(FIELD_KW, function(k) { return strIncludes(text, k); });
  });

  var withCriteria    = 0;
  var withoutCriteria = 0;

  for (var i = 0; i < relevant.length; i++) {
    var c = relevant[i];
    var text = ((c.title || "") + " " + (c.description || "")).toLowerCase();
    var hasConcrete = arrSome(CONCRETE_KW, function(k) { return strIncludes(text, k); });

    if (!hasConcrete) {
      withoutCriteria++;
      issues.push(mkIssue(
        "medium", "behaviors",
        'Validação sem critério implementável: "' + (c.title || c.nodeName) + '"',
        'O card descreve uma validação de campo mas não especifica critérios concretos como limite de caracteres, formato esperado ou texto da mensagem de erro.',
        'Adicione ao menos um: limite (ex: "mínimo 8 caracteres"), formato (ex: "somente números") ou mensagem exata (ex: erro: "CPF inválido").',
        c.nodeId
      ));
    } else {
      withCriteria++;
    }
  }

  if (withoutCriteria === 0 && relevant.length > 0) {
    strengths.push({
      title: "Validações com critérios implementáveis",
      description: "Todos os cards de validação especificam critérios concretos que Engenharia pode implementar diretamente.",
    });
  }

  // Score: 100 se todos ok, reduz proporcionalmente
  var score = relevant.length === 0
    ? 100
    : Math.round((withCriteria / relevant.length) * 100);

  return { issues: issues, strengths: strengths, score: score };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
function calcScore(dimScores, issues) {
  var hasCrit = arrSome(issues, function(i) { return i.isCriticalBlocker; });
  var keys = Object.keys(DIM_WEIGHTS);
  var dims = arrMap(keys, function(k) {
    var raw = (dimScores[k] !== undefined ? dimScores[k] : 50);
    return { dimension: k, label: DIM_LABELS[k], weight: DIM_WEIGHTS[k], raw: raw, weighted: raw * DIM_WEIGHTS[k] };
  });
  var total = 0;
  for (var i = 0; i < dims.length; i++) total += dims[i].weighted;
  total = Math.round(total);
  var classification, label;
  if (total >= 85 && !hasCrit) { classification = "ready_for_eng"; label = "Pronto para engenharia"; }
  else if (total >= 70) { classification = hasCrit ? "needs_review" : "can_proceed"; label = hasCrit ? "Precisa de revisão (bloqueios críticos)" : "Pode seguir com ressalvas"; }
  else if (total >= 50) { classification = "needs_review"; label = "Precisa de revisão"; }
  else { classification = "not_ready"; label = "Não recomendado para handoff"; }
  return { total: total, classification: classification, classificationLabel: label, hasCriticalBlockers: hasCrit, dimensions: dims };
}

// ─── Markdown Exporter ────────────────────────────────────────────────────────
function genMarkdown(result) {
  var s = result.score, issues = result.issues, strengths = result.strengths, cov = result.stateCoverage;
  var lines = [
    "# Relatório de Auditoria de Handoff", "",
    "**Score:** " + s.total + "/100",
    "**Classificação:** " + s.classificationLabel,
    "**Tipo de fluxo:** " + result.flowType,
    "**Data:** " + new Date(result.timestamp).toLocaleString("pt-BR"), "",
    "## Score por dimensão", "",
    "| Dimensão | Peso | Score |", "|---|---:|---:|",
  ];
  for (var i = 0; i < s.dimensions.length; i++) {
    var d = s.dimensions[i];
    lines.push("| " + d.label + " | " + Math.round(d.weight * 100) + "% | " + d.raw + " |");
  }
  lines.push("");
  if (strengths.length) {
    lines.push("## ✅ Pontos fortes", "");
    for (var i = 0; i < strengths.length; i++) lines.push("- **" + strengths[i].title + ":** " + strengths[i].description);
    lines.push("");
  }
  var blockers = arrFilter(issues, function(i) { return i.isCriticalBlocker; });
  if (blockers.length) {
    lines.push("## 🚫 Bloqueios críticos", "");
    for (var i = 0; i < blockers.length; i++) {
      lines.push("### " + blockers[i].title, blockers[i].description, "> **Recomendação:** " + blockers[i].recommendation, "");
    }
  } else { lines.push("## ✅ Nenhum bloqueio crítico", ""); }
  var sevs = ["critical","high","medium","low"];
  var sevLabel = { critical: "🔴 Crítico", high: "🟠 Alto", medium: "🟡 Médio", low: "🔵 Baixo" };
  for (var s2 = 0; s2 < sevs.length; s2++) {
    var sev = sevs[s2];
    var g = arrFilter(issues, function(i) { return i.severity === sev && !i.isCriticalBlocker; });
    if (!g.length) continue;
    lines.push("## " + sevLabel[sev], "");
    for (var i = 0; i < g.length; i++) lines.push("### " + g[i].title, g[i].description, "> **Recomendação:** " + g[i].recommendation, "");
  }
  lines.push("## Cobertura de estados (" + result.flowType + ")", "");
  if (cov.found.length) lines.push("**Encontrados:** " + cov.found.join(", "));
  if (cov.missing.length) lines.push("**Ausentes:** " + cov.missing.join(", "));
  return lines.join("\n");
}

// ─── Main Audit ───────────────────────────────────────────────────────────────
function runAudit(flowType, scope) {
  figma.ui.postMessage({ type: "progress", pct: 30 });

  setTimeout(function() {
    try {
      var scanResult = scan(scope);
      var allFlat    = scanResult.allFlat;
      var handoff    = scanResult.handoffNodes;

      figma.ui.postMessage({ type: "progress", pct: 60 });

      var cards     = parseCards(handoff);
      var markers   = parseMarkers(handoff);
      var decisions = parseDecisions(handoff);

      // Detecta auditoria de frame único (ex: Section/Frame scope com 1 frame selecionado)
      // Nesse caso itens contextuais de fluxo completo não se aplicam
      var isSingleFrame = (scope === 'section' &&
        scanResult.rootNodes.length === 1 &&
        scanResult.rootNodes[0].type === 'FRAME');

      var ctx       = isSingleFrame
        ? { issues: [], strengths: [], score: 50 }
        : validateContext(cards, allFlat);
      var org       = validateOrganization(scanResult.rootNodes, handoff);
      // Verifica estrutura de páginas (ENTREGAR → 📂 Fluxos → handoff) e funde em organization
      var pageStruct = validatePageStructure();
      org.issues = org.issues.concat(pageStruct.issues);
      org.score  = Math.round(org.score * 0.7 + pageStruct.score * 0.3);

      var trace     = validateTraceability(cards, markers);
      var dec       = validateDecisions(decisions);
      var states    = validateStates(cards, allFlat, flowType, scanResult.rootNodes);
      var quality   = validateCardQuality(cards);
      var structure = validateStructure(cards, allFlat);
      var specs     = validateSpecs(allFlat);
      var assets    = validateAssets(scanResult.rootNodes);
      var layout    = validateScreenLayout(scanResult.rootNodes);
      var concreteV = validateConcreteValidations(cards);

      // Para frame único: remover issue de "fora de escopo não listado" (não faz sentido numa tela só)
      if (isSingleFrame) {
        structure.issues = arrFilter(structure.issues, function(i) {
          return i.title.indexOf('O que não será entregue') === -1;
        });
      }

      // Adiciona nodeId de container às issues de estado sem nodeId,
      // para que clicar em "Estado ausente" navegue ao frame raiz do fluxo
      var firstRootId = scanResult.rootNodes.length > 0 ? scanResult.rootNodes[0].id : null;
      if (firstRootId) {
        for (var si = 0; si < states.issues.length; si++) {
          if (!states.issues[si].nodeId) states.issues[si].nodeId = firstRootId;
        }
      }

      // Detecta section/frame de "caso de uso" — aceita singular, plural e variações
      // "caso de uso", "casos de uso", "Casos de Uso", "use case", etc.
      var _useCasePattern = /casos?\s*de\s*uso|use\s*cases?/i;
      var hasUseCaseSection = arrSome(allFlat, function(n) {
        return n.name && _useCasePattern.test(n.name);
      });

      // Captura o nome da section/frame analisada (scope 'section' com seleção única)
      var sectionName = null;
      if (scope === 'section' && scanResult.rootNodes.length === 1) {
        sectionName = scanResult.rootNodes[0].name || null;
      }

      figma.ui.postMessage({ type: "progress", pct: 90 });

      var allIssues    = [].concat(ctx.issues, org.issues, trace.issues, dec.issues, states.issues, quality.issues, concreteV.issues, specs.issues, assets.issues, structure.issues, layout.issues);
      var allStrengths = [].concat(ctx.strengths, org.strengths, trace.strengths, dec.strengths, states.strengths, quality.strengths, concreteV.strengths, specs.strengths, assets.strengths, structure.strengths, layout.strengths);

      var score = calcScore({
        context:      ctx.score,
        organization: org.score,
        structure:    structure.score,
        decisions:    dec.score,
        states:       states.score,
        behaviors:    Math.round((quality.score + concreteV.score) / 2),
        // specs: média entre anotações de espaçamento e assets prontos para exportação
        specs:        Math.round((specs.score + assets.score) / 2),
        traceability: trace.score,
        layout:       layout.score,
      }, allIssues);

      var result = {
        flowType:          flowType,
        scope:             scope,
        sectionName:       sectionName,
        hasUseCaseSection: hasUseCaseSection,
        timestamp:         new Date().toISOString(),
        nodesScanned:      scanResult.totalScanned,
        score:             score,
        issues:            allIssues,
        strengths:         allStrengths,
        stateCoverage:     states.coverage,
        screenScores:      layout.screenScores,
        markdown:          genMarkdown({
          flowType:      flowType,
          timestamp:     new Date().toISOString(),
          score:         score,
          issues:        allIssues,
          strengths:     allStrengths,
          stateCoverage: states.coverage,
        }),
      };

      figma.ui.postMessage({ type: "result", result: result });

    } catch (err) {
      figma.ui.postMessage({ type: "error", message: String(err) });
    }
  }, 0);
}

// ─── Message Handler ────────────────────────────────────────────────────────────────────────────────
figma.ui.onmessage = function(msg) {
  if (msg.type === 'ui_ready') {
    loadHistory(function(entries) {
      figma.ui.postMessage({ type: 'history_restore', entries: entries });
    });
  }

  if (msg.type === 'save_history') {
    saveHistory(msg.entries);
  }

  if (msg.type === "run-audit") {
    runAudit(msg.flowType, msg.scope);
  }
  if (msg.type === "navigate") {
    figma.getNodeByIdAsync(msg.nodeId).then(function(node) {
      if (node) {
        figma.viewport.scrollAndZoomIntoView([node]);
        figma.currentPage.selection = [node];
      }
      figma.ui.postMessage({ type: 'navigate-done' });
    }).catch(function(err) {
      figma.ui.postMessage({ type: 'navigate-done' });
    });
  }

  if (msg.type === 'create-use-case-section') {
    try {
      var newSection = figma.createSection ? figma.createSection() : figma.createFrame();
      newSection.name = 'Caso de uso';
      var pageChildren = Array.from(figma.currentPage.children);
      if (pageChildren.length > 0) {
        var maxX = 0;
        for (var pi = 0; pi < pageChildren.length; pi++) {
          var nx = (pageChildren[pi].x || 0) + (pageChildren[pi].width || 0) + 80;
          if (nx > maxX) maxX = nx;
        }
        newSection.x = maxX; newSection.y = 0;
      }
      try { figma.viewport.scrollAndZoomIntoView([newSection]); } catch(e) {}
      figma.currentPage.selection = [newSection];
      figma.ui.postMessage({ type: 'navigate-done' });
    } catch(err) {
      figma.ui.postMessage({ type: 'error', message: 'Erro ao criar section: ' + String(err) });
    }
  }
};

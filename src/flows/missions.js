import { sendList, sendText } from "../services/whatsapp.js";
import { sendActionButtons } from "./menus.js";
import {
  calcMissaoTaxa,
  calcMissaoTotal,
  createPendingPayment,
  
} from "../lib/monetization.js";
import { createMercadoPagoPixIntent } from "../services/payments.js";

function inferCategoria(text = "") {
  const t = String(text).toLowerCase();

  if (t.includes("limp") || t.includes("faxina") || t.includes("lavar") || t.includes("capin")) {
    return "limpeza";
  }
  if (t.includes("frete") || t.includes("mudan") || t.includes("transport")) {
    return "frete";
  }
  if (t.includes("pet") || t.includes("cachorro") || t.includes("passear")) {
    return "passeio_pet";
  }
  if (t.includes("jard")) {
    return "jardinagem";
  }
  if (t.includes("mont")) {
    return "montagem";
  }
  if (t.includes("entrega")) {
    return "entrega";
  }

  return "outros";
}

function buildPixResumo(intent, resumo) {
  const checkoutUrl = intent?.checkout_url || null;

  let out =
    `💳 Pagamento da missão gerado com sucesso!\n\n` +
    `Valor da missão: R$ ${resumo.valorMissao.toFixed(2)}\n` +
    `Taxa da plataforma: R$ ${resumo.taxa.toFixed(2)}\n` +
    `Urgência: R$ ${resumo.urgencia.toFixed(2)}\n` +
    `Total: R$ ${resumo.total.toFixed(2)}`;

  if (checkoutUrl) out += `\n\n🔗 Link de pagamento:\n${checkoutUrl}`;
  return out;
}

function buildPixCodeOnly(intent) {
  return intent?.qr_code || "Código Pix indisponível no momento.";
}

function statusLabel(status) {
  const map = {
    pendente_pagamento: "Pendente pagamento",
    aberta: "Aberta",
    aguardando_aprovacao_dono: "Aguardando sua aprovação",
    em_andamento: "Em andamento",
    aguardando_confirmacao_dono: "Aguardando confirmação do dono",
    aguardando_confirmacao_executor: "Aguardando confirmação do executor",
    concluida: "Concluída",
    cancelada: "Cancelada",
  };
  return map[status] || status;
}
function money(value = 0) {
  return Number(value || 0).toFixed(2);
}

function getValorRecompensa(missao) {
  return Number(missao.valor_por_pessoa || missao.valor || 0);
}function getValorBrutoRecompensa(missao) {
  return Number(missao.valor_por_pessoa || missao.valor || 0);
}

function getTaxaExecutor(missao) {
  return getValorBrutoRecompensa(missao) * 0.1;
}



function getVagasRestantes(missao) {
  const total = Number(missao.vagas_total || 1);
  const ocupadas = Number(missao.vagas_ocupadas || 0);
  return Math.max(0, total - ocupadas);
}

async function ensureCarteira(supabase, usuarioId) {
  const { data: existente } = await supabase
    .from("carteiras")
    .select("*")
    .eq("usuario_id", usuarioId)
    .maybeSingle();

  if (existente) return existente;

  const { data, error } = await supabase
    .from("carteiras")
    .insert({ usuario_id: usuarioId, saldo: 0, saldo_pendente: 0 })
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao criar carteira:", error);
    return null;
  }

  return data;
}
async function atualizarCarteiraValores({ supabase, usuarioId, saldoDelta = 0, pendenteDelta = 0 }) {
  const carteira = await ensureCarteira(supabase, usuarioId);
  if (!carteira) return false;

  const novoSaldo = Math.max(0, Number(carteira.saldo || 0) + Number(saldoDelta || 0));
  const novoPendente = Math.max(
    0,
    Number(carteira.saldo_pendente || 0) + Number(pendenteDelta || 0)
  );

  const { error } = await supabase
    .from("carteiras")
    .update({
      saldo: novoSaldo,
      saldo_pendente: novoPendente,
    })
    .eq("usuario_id", usuarioId);

  if (error) {
    console.error("❌ erro ao atualizar carteira:", error);
    return false;
  }

  return true;
}

function getValorTotalMissao(missao) {
  return Number(missao.valor_total || missao.valor || 0);
}

function getTaxaMissao(missao) {
  return Number(missao.taxa_plataforma || 0);
}

function getUrgenciaMissao(missao) {
  return missao.urgencia ? 4.9 : 0;
}

async function reterTaxaMissaoSePrimeiroAceite({ supabase, missao }) {
  if (missao.taxa_retida) return true;

  const taxa = getTaxaMissao(missao) + getUrgenciaMissao(missao);
  if (taxa <= 0) {
    await supabase.from("missoes").update({ taxa_retida: true }).eq("id", missao.id);
    return true;
  }

  await atualizarCarteiraValores({
    supabase,
    usuarioId: missao.usuario_id,
    saldoDelta: 0,
    pendenteDelta: -taxa,
  });

  await supabase.from("transacoes").insert({
    usuario_id: missao.usuario_id,
    tipo: "debito",
    valor: taxa,
    descricao: `Taxa retida da missão: ${missao.titulo}`,
    status: "concluido",
    referencia_tipo: "taxa_missao",
    referencia_id: missao.id,
  });

  await supabase.from("missoes").update({ taxa_retida: true }).eq("id", missao.id);

  return true;
}

async function descontarReservaDoDono({ supabase, missao }) {
  const valorBruto = getValorBrutoRecompensa(missao);

  await atualizarCarteiraValores({
    supabase,
    usuarioId: missao.usuario_id,
    saldoDelta: 0,
    pendenteDelta: -valorBruto,
  });

  await supabase.from("transacoes").insert({
    usuario_id: missao.usuario_id,
    tipo: "debito",
    valor: valorBruto,
    descricao: `Pagamento bruto liberado para executor: ${missao.titulo}`,
    status: "concluido",
    referencia_tipo: "pagamento_executor",
    referencia_id: missao.id,
  });

  return true;
}

async function devolverSaldoMissaoCancelada({ supabase, missao }) {
  const totalMissao = getValorTotalMissao(missao);
  const taxa = getTaxaMissao(missao) + getUrgenciaMissao(missao);
  const houveAceite = Number(missao.vagas_ocupadas || 0) > 0 || missao.taxa_retida;

  const { data: creditosPagos } = await supabase
    .from("transacoes")
    .select("valor")
    .eq("referencia_tipo", "missao")
    .eq("referencia_id", missao.id)
    .eq("tipo", "credito")
    .eq("status", "concluido");

  const totalJaPago = (creditosPagos || []).reduce(
    (acc, item) => acc + Number(item.valor || 0),
    0
  );

  const valorLivreDaMissao = Math.max(0, totalMissao - totalJaPago);
  const valorDevolver = houveAceite ? valorLivreDaMissao : valorLivreDaMissao + taxa;
  const pendenteBaixar = houveAceite ? valorLivreDaMissao : valorLivreDaMissao + taxa;

  if (valorDevolver > 0) {
    await atualizarCarteiraValores({
      supabase,
      usuarioId: missao.usuario_id,
      saldoDelta: valorDevolver,
      pendenteDelta: -pendenteBaixar,
    });

    await supabase.from("transacoes").insert({
      usuario_id: missao.usuario_id,
      tipo: "credito",
      valor: valorDevolver,
      descricao: `Devolução de missão cancelada: ${missao.titulo}`,
      status: "concluido",
      referencia_tipo: "cancelamento_missao",
      referencia_id: missao.id,
    });
  }

  return {
    valorDevolver,
    taxaRetida: houveAceite ? taxa : 0,
  };
}
async function creditarMissaoNaCarteira({ supabase, usuarioId, missao }) {
  const valorBruto = getValorBrutoRecompensa(missao);
  const taxaExecutor = getTaxaExecutor(missao);
  const valorLiquido = getValorRecompensa(missao);

  const carteira = await ensureCarteira(supabase, usuarioId);
  if (!carteira) return false;

  const { data: jaExiste } = await supabase
    .from("transacoes")
    .select("id")
    .eq("usuario_id", usuarioId)
    .eq("referencia_tipo", "missao")
    .eq("referencia_id", missao.id)
    .maybeSingle();

  if (jaExiste) {
    console.log("⚠️ já creditado antes");
    return false;
  }

  const { error: updateError } = await supabase.rpc("incrementar_saldo", {
    uid: usuarioId,
    valor_add: valorLiquido,
  });

  if (updateError) {
    console.error("❌ erro ao atualizar saldo:", updateError);
    return false;
  }

  await supabase.from("transacoes").insert([
    {
      usuario_id: usuarioId,
      tipo: "credito",
      valor: valorLiquido,
      descricao: `Recompensa líquida da missão: ${missao.titulo}`,
      status: "concluido",
      referencia_tipo: "missao",
      referencia_id: missao.id,
    },
    {
      usuario_id: usuarioId,
      tipo: "debito",
      valor: taxaExecutor,
      descricao: `Taxa da plataforma sobre missão: ${missao.titulo}`,
      status: "concluido",
      referencia_tipo: "taxa_executor_missao",
      referencia_id: missao.id,
    },
  ]);

  console.log("✅ missão creditada com taxa do executor:", {
    usuarioId,
    valorBruto,
    taxaExecutor,
    valorLiquido,
  });

  return true;
}
async function enviarResumoCarteira(supabase, phone, user) {
  const carteira = await ensureCarteira(supabase, user.id);

  await sendText(
    phone,
    `💰 *Minha carteira*\n\n` +
      `Saldo disponível: R$ ${money(carteira?.saldo)}\n` +
      `Saldo pendente: R$ ${money(carteira?.saldo_pendente)}`
  );

  return sendActionButtons(phone, "O que deseja fazer agora?", [
    { id: "carteira_sacar", title: "Solicitar saque" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}


function buildMissaoPublicaDetalhe(missao, nomeCriador = "Não informado") {
  const valorPessoa = getValorRecompensa(missao);
  const vagasRestantes = getVagasRestantes(missao);

  let out =
    `📌 *${missao.titulo || "Missão"}*\n\n` +
    `👤 *Solicitante:* ${nomeCriador}\n\n` +
    `📝 *Descrição:*\n${missao.descricao || "-"}\n\n` +
    `💰 *Você ganha:* R$ ${money(valorPessoa)}\n`;

  if ((missao.tipo || "individual") === "campanha") {
    out +=
      `👥 *Vagas totais:* ${missao.vagas_total || 1}\n` +
      `✅ *Ocupadas:* ${missao.vagas_ocupadas || 0}\n` +
      `🟢 *Restantes:* ${vagasRestantes}\n`;
  }

  out +=
    `📍 *Cidade:* ${missao.cidade || "-"}${missao.estado ? `/${missao.estado}` : ""}\n` +
    `⚡ *Status:* ${statusLabel(missao.status)}`;

  return out;
}

function buildMissoesPreviewLocked(missoes = []) {
  if (!missoes.length) {
    return "Sem missões no momento.";
  }

  const preview = missoes.slice(0, 3);
  const restante = Math.max(0, missoes.length - preview.length);

  let out = "🛠️ *Encontramos missões para você:*\n";

  preview.forEach((missao) => {
    const nomeCriador = missao?.usuarios?.nome || "Solicitante";

    out +=
      `\n\n• *${missao.titulo || "Missão"}*` +
      `\n👤 ${nomeCriador}` +
      `\n💰 R$ ${Number(missao.valor || 0).toFixed(2)}` +
      `\n📍 ${missao.cidade || "Sem cidade"}${missao.estado ? `/${missao.estado}` : ""}`;
  });

  if (restante > 0) {
    out += `\n\n📌 E ainda existem *mais ${restante} missão(ões)* nessa busca.`;
  }

  out +=
    "\n\n🔒 Você está vendo apenas as *3 primeiras missões*." +
    "\nPara liberar a lista completa, o desbloqueio é *avulso*." +
    "\n\n📣 Se preferir, você também pode assinar um pacote de missões ou um pacote combinado.";

  return out;
}

async function sendMissoesUnlockedList(phone, missoes = []) {
  if (!missoes.length) {
    return sendText(phone, "Sem missões no momento.");
  }

  return sendList(phone, "🛠️ Escolha uma missão para ver os detalhes:", [
    {
      title: "Missões disponíveis",
      rows: missoes.slice(0, 10).map((m) => ({
        id: `missao_publica_${m.id}`,
        title: `📌 ${String(m.titulo || "Missão").slice(0, 21)}`,
        description: `💰 R$ ${money(getValorRecompensa(m))} • ${
  (m.tipo || "individual") === "campanha"
    ? `${getVagasRestantes(m)} vagas`
    : "1 vaga"
}`.slice(0, 72),
      })),
    },
  ]);
}

async function gerarPagamentoMissaoAvulso({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_missoes_avulso",
    planoCodigo: "missao_avulsa_usuario",
    valor: 4.9,
    metadata: {
      modo: "desbloqueio_lista_missoes",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança das missões.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix das missões:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Desbloqueio avulso de missões\n` +
        `💵 *Valor:* R$ 4.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Desbloqueio avulso de missões\n` +
      `💵 *Valor:* R$ 4.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, a lista completa das missões ficará liberada."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "user_ver_missoes", title: "Ver missões" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

async function gerarPagamentoMissaoMensal({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_missoes_mensal",
    planoCodigo: "usuario_missoes_mensal",
    valor: 19.9,
    metadata: {
      cobertura: "missoes",
      periodicidade: "mensal",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança do plano de missões.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix do plano mensal de missões:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Missões mensais\n` +
        `💵 *Valor:* R$ 19.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Missões mensais\n` +
      `💵 *Valor:* R$ 19.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, você terá acesso às missões por 30 dias."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "user_ver_missoes", title: "Ver missões" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

async function gerarPagamentoComboVagasMissoes({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_vagas_missoes_mensal",
    planoCodigo: "usuario_vagas_missoes_mensal",
    valor: 29.9,
    metadata: {
      cobertura: "vagas_missoes",
      periodicidade: "mensal",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança do plano combo.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix do combo vagas + missões:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Vagas + Missões mensal\n` +
        `💵 *Valor:* R$ 29.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Vagas + Missões mensal\n` +
      `💵 *Valor:* R$ 29.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, você terá acesso a vagas e missões por 30 dias."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

async function gerarPagamentoPlanoTotal({ supabase, phone, user }) {
  const payment = await createPendingPayment(supabase, {
    usuarioId: user.id,
    referenciaTipo: "usuario_total_mensal",
    planoCodigo: "usuario_total_mensal",
    valor: 39.9,
    metadata: {
      cobertura: "total",
      periodicidade: "mensal",
      escopo: "todas",
      cidade: user.cidade || null,
      estado: user.estado || null,
      categoria_principal: user.categoria_principal || null,
    },
  });

  if (!payment) {
    await sendText(phone, "Erro ao gerar cobrança do plano completo.");
    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  let intent = null;
  try {
    intent = await createMercadoPagoPixIntent(payment.id);
  } catch (err) {
    console.error("❌ erro ao gerar Pix do plano completo:", err);
  }

  if (!intent) {
    await sendText(
      phone,
      `💳 *Pedido criado com sucesso!*\n\n` +
        `📦 *Plano:* Completo mensal\n` +
        `💵 *Valor:* R$ 39.90\n` +
        `🆔 *Pedido:* ${payment.id}\n\n` +
        `Não consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
    );

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "jobs_pacotes", title: "Ver pacotes" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `💳 *Pagamento gerado com sucesso!*\n\n` +
      `📦 *Plano:* Completo mensal\n` +
      `💵 *Valor:* R$ 39.90` +
      (intent?.checkout_url ? `\n\n🔗 *Link de pagamento:*\n${intent.checkout_url}` : "")
  );

  await sendText(phone, intent?.qr_code || "Código Pix indisponível no momento.");

  await sendText(
    phone,
    "✅ Assim que o pagamento for aprovado, você terá acesso completo a vagas e missões por 30 dias."
  );

  return sendActionButtons(phone, "Depois do pagamento:", [
    { id: "payment_check_status", title: "Já paguei" },
    { id: "jobs_pacotes", title: "Ver pacotes" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}


async function enviarMissaoParaDono(phone, missao, interessado) {
  return sendActionButtons(
    phone,
    `📩 Novo interessado na sua missão\n\nMissão: ${missao.titulo}\nInteressado: ${interessado.nome || "Usuário"}\nTelefone: ${interessado.telefone}`,
    [
      { id: `missao_aprovar_${missao.id}_${interessado.id}`, title: "Aceitar executor" },
      { id: `missao_recusar_${missao.id}_${interessado.id}`, title: "Recusar" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]
  );
}

export async function handleMissions({
  user,
  text,
  phone,
  supabase,
  updateUser,
}) {
  // =====================
  // LISTA PÚBLICA DE MISSÕES
  // =====================



// ATIVAR PACOTE AVULSO DE MISSOES 


  {/* const paidAccess = await hasPaidAccessForMissions(supabase, user.id);
if (text === "missoes_buy_single") {
  return gerarPagamentoMissaoAvulso({
    supabase,
    phone,
    user,
  });
} */}
if (text === "user_carteira") {
  return enviarResumoCarteira(supabase, phone, user);
}

if (text === "carteira_sacar") {
  const carteira = await ensureCarteira(supabase, user.id);

  if (Number(carteira?.saldo || 0) <= 0) {
    return sendText(phone, "Você ainda não tem saldo disponível para saque.");
  }

  if (!carteira.pix_chave || !carteira.pix_chave_tipo) {
    await updateUser({ etapa: "saque_pix_tipo" });

    return sendList(phone, "Escolha o tipo da sua chave Pix:", [
      {
        title: "Tipo de chave",
        rows: [
          { id: "pix_tipo_cpf", title: "CPF" },
          { id: "pix_tipo_cnpj", title: "CNPJ" },
          { id: "pix_tipo_email", title: "E-mail" },
          { id: "pix_tipo_celular", title: "Celular" },
          { id: "pix_tipo_aleatoria", title: "Chave aleatória" },
        ],
      },
    ]);
  }

  await updateUser({ etapa: "saque_valor" });

  return sendText(
    phone,
    `💰 Saldo disponível: R$ ${money(carteira.saldo)}\n\nQuanto deseja sacar?`
  );
}
if (user.etapa === "saque_pix_tipo") {
  if (!text.startsWith("pix_tipo_")) {
    return sendText(phone, "Escolha o tipo da chave Pix pela lista.");
  }

  const tipo = text.replace("pix_tipo_", "");

  await updateUser({
    etapa: "saque_pix_chave",
    pix_chave_tipo_temp: tipo,
  });

  return sendText(phone, "Agora digite sua chave Pix:");
}

if (user.etapa === "saque_pix_chave") {
  const chave = String(text || "").trim();

  if (chave.length < 3) {
    return sendText(phone, "Digite uma chave Pix válida.");
  }

  await ensureCarteira(supabase, user.id);

  await supabase
    .from("carteiras")
    .update({
      pix_chave_tipo: user.pix_chave_tipo_temp || "nao_informado",
      pix_chave: chave,
    })
    .eq("usuario_id", user.id);

  await updateUser({
    etapa: "saque_valor",
    pix_chave_tipo_temp: null,
  });

  const carteira = await ensureCarteira(supabase, user.id);

  return sendText(
    phone,
    `✅ Chave Pix cadastrada.\n\nSaldo disponível: R$ ${money(carteira.saldo)}\n\nQuanto deseja sacar?`
  );
}

if (user.etapa === "saque_valor") {
  const valor = Number(String(text).replace(",", "."));
  const carteira = await ensureCarteira(supabase, user.id);

  if (!valor || valor <= 0) {
    return sendText(phone, "Digite um valor válido para saque.");
  }

  if (valor > Number(carteira.saldo || 0)) {
    return sendText(phone, `Saldo insuficiente. Seu saldo é R$ ${money(carteira.saldo)}.`);
  }

  const novoSaldo = Number(carteira.saldo || 0) - valor;
  const novoPendente = Number(carteira.saldo_pendente || 0) + valor;

  await supabase
    .from("carteiras")
    .update({
      saldo: novoSaldo,
      saldo_pendente: novoPendente,
    })
    .eq("usuario_id", user.id);

  await supabase.from("saques").insert({
    usuario_id: user.id,
    valor,
    chave_pix: carteira.pix_chave,
    chave_pix_tipo: carteira.pix_chave_tipo,
    status: "pendente",
  });

  await supabase.from("transacoes").insert({
    usuario_id: user.id,
    tipo: "debito",
    valor,
    descricao: "Solicitação de saque",
    status: "pendente",
    referencia_tipo: "saque",
  });

  await updateUser({ etapa: "menu" });

  await sendText(
    phone,
    `💰 *Saque solicitado*\n\n` +
      `Valor: R$ ${money(valor)}\n` +
      `Chave Pix: ${carteira.pix_chave}\n\n` +
      `Saldo disponível agora: R$ ${money(novoSaldo)}\n` +
      `Saldo em processamento: R$ ${money(novoPendente)}`
  );

  return sendText(
    phone,
    "✅ Sua solicitação de saque está em processamento. Assim que for pago, você receberá a confirmação por aqui."
  );
}
if (text === "user_ver_missoes") {
  const { data: missoes, error } = await supabase
    .from("missoes")
    .select(`
      *,
      usuarios:usuarios!missoes_usuario_id_fkey (
        id,
        nome,
        telefone
      )
    `)
    .eq("status", "aberta")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("❌ erro ao buscar missões:", error);
    await sendText(phone, "Erro ao buscar missões.");
    return sendActionButtons(phone, [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (!missoes?.length) {
    await sendText(phone, "Sem missões no momento.");
    return sendActionButtons(phone, [
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  await sendText(
    phone,
    `✅ Encontramos *${missoes.length}* missão(ões) disponíveis para você.`
  );

  return sendMissoesUnlockedList(phone, missoes);
}

  if (text.startsWith("missao_publica_")) {
    const missaoId = text.replace("missao_publica_", "");
const { data: missao, error } = await supabase
  .from("missoes")
  .select(`
    *,
    usuarios:usuarios!missoes_usuario_id_fkey (
      id,
      nome,
      telefone
    )
  `)
  .eq("id", missaoId)
  .maybeSingle();

    if (error || !missao) {
      await sendText(phone, "Missão não encontrada.");
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "user_ver_missoes", title: "Ver missões" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    await sendText(
  phone,
  buildMissaoPublicaDetalhe(missao, missao?.usuarios?.nome || "Não informado")
);

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: `missao_aceitar_${missao.id}`, title: "Aceitar missão" },
      { id: "user_ver_missoes", title: "Ver missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (text.startsWith("missao_aceitar_")) {
  const missaoId = text.replace("missao_aceitar_", "");

  const { data: missao, error } = await supabase
    .from("missoes")
    .select("*")
    .eq("id", missaoId)
    .maybeSingle();

  if (error || !missao) return sendText(phone, "Missão não encontrada.");

  const allowSelfMissionTest = process.env.ALLOW_SELF_MISSION_TEST === "true";

if (missao.usuario_id === user.id && !allowSelfMissionTest) {
  return sendText(phone, "Você não pode aceitar a própria missão.");
}

  if (missao.status !== "aberta") {
    return sendText(phone, "Essa missão não está mais disponível.");
  }

  const tipo = missao.tipo || "individual";
  await reterTaxaMissaoSePrimeiroAceite({
  supabase,
  missao,
});
if (tipo === "campanha") {
  const total = Number(missao.vagas_total || 1);
  const ocupadas = Number(missao.vagas_ocupadas || 0);

  if (ocupadas >= total) {
    return sendText(phone, "Essa campanha já atingiu o limite de participantes.");
  }

  const novasOcupadas = ocupadas + 1;
  const novoStatus = novasOcupadas >= total ? "encerrada" : "aberta";

  const { error: interessadoError } = await supabase
    .from("missoes_interessados")
    .upsert(
      {
        missao_id: missao.id,
        usuario_id: user.id,
        status: "aceito",
      },
      { onConflict: "missao_id,usuario_id" }
    );

  if (interessadoError) {
    console.error("❌ erro ao aceitar campanha:", interessadoError);
    return sendText(phone, "Erro ao aceitar missão.");
  }

  await supabase
    .from("missoes")
    .update({
      vagas_ocupadas: novasOcupadas,
      status: novoStatus,
    })
    .eq("id", missao.id);

  const { data: dono } = await supabase
    .from("usuarios")
    .select("id,nome,telefone")
    .eq("id", missao.usuario_id)
    .maybeSingle();

  if (dono?.telefone) {
    await sendText(
      dono.telefone,
      `📩 Nova pessoa aceitou sua campanha\n\n` +
        `📌 Missão: ${missao.titulo}\n` +
        `👤 Executor: ${user.nome || "Usuário"}\n` +
        `📱 Telefone: ${user.telefone}\n` +
        `💰 Valor por pessoa: R$ ${money(getValorRecompensa(missao))}\n` +
        `👥 Vagas restantes: ${Math.max(0, total - novasOcupadas)}`
    );
  }

  await sendText(
    phone,
    `✅ Você aceitou essa missão!\n\n` +
      `💰 Ao concluir e ser aprovado, você recebe: R$ ${money(getValorRecompensa(missao))}\n` +
      `👥 Vagas restantes: ${Math.max(0, total - novasOcupadas)}`
  );

  return sendActionButtons(phone, "Quando concluir:", [
    { id: `missao_executor_concluir_${missao.id}`, title: "Marcar concluída" },
    { id: "user_ver_missoes", title: "Ver missões" },
    { id: "voltar_menu", title: "Voltar ao menu" },
  ]);
}

  const { error: interessadoError } = await supabase
    .from("missoes_interessados")
    .upsert(
      {
        missao_id: missao.id,
        usuario_id: user.id,
        status: "interessado",
      },
      { onConflict: "missao_id,usuario_id" }
    );

  if (interessadoError) {
    console.error("❌ erro ao registrar interessado:", interessadoError);
    return sendText(phone, "Erro ao registrar interesse na missão.");
  }

  await supabase
    .from("missoes")
    .update({ status: "aguardando_aprovacao_dono" })
    .eq("id", missao.id)
    .eq("status", "aberta");

  const { data: dono } = await supabase
    .from("usuarios")
    .select("id,nome,telefone")
    .eq("id", missao.usuario_id)
    .maybeSingle();

  if (dono?.telefone) {
    await enviarMissaoParaDono(dono.telefone, missao, {
      id: user.id,
      nome: user.nome,
      telefone: user.telefone,
    });
  }

  return sendText(phone, "✅ Seu interesse foi registrado com sucesso.");
}

  if (text.startsWith("missao_aprovar_")) {
    const parts = text.split("_");
    const missaoId = parts[2];
    const executorId = parts[3];

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .maybeSingle();

    if (!missao || missao.usuario_id !== user.id) {
      return sendText(phone, "Missão não encontrada para aprovação.");
    }

    await supabase
      .from("missoes")
      .update({
        status: "em_andamento",
        executor_usuario_id: executorId,
      })
      .eq("id", missaoId);

    await supabase
      .from("missoes_interessados")
      .update({ status: "aceito" })
      .eq("missao_id", missaoId)
      .eq("usuario_id", executorId);

    await supabase
      .from("missoes_interessados")
      .update({ status: "recusado" })
      .eq("missao_id", missaoId)
      .neq("usuario_id", executorId);

    const { data: executor } = await supabase
      .from("usuarios")
      .select("telefone")
      .eq("id", executorId)
      .maybeSingle();

    if (executor?.telefone) {
      await sendActionButtons(
        executor.telefone,
        `✅ Sua execução foi aceita!\n\nMissão: ${missao.titulo}`,
        [
          { id: `missao_executor_concluir_${missao.id}`, title: "Marcar concluída" },
          { id: "voltar_menu", title: "Voltar ao menu" },
        ]
      );
    }

    return sendText(phone, "✅ Executor aceito. A missão agora está em andamento.");
  }

  if (text.startsWith("missao_recusar_")) {
    const parts = text.split("_");
    const missaoId = parts[2];
    const executorId = parts[3];

    await supabase
      .from("missoes_interessados")
      .update({ status: "recusado" })
      .eq("missao_id", missaoId)
      .eq("usuario_id", executorId);

    const { data: pendentes } = await supabase
      .from("missoes_interessados")
      .select("*")
      .eq("missao_id", missaoId)
      .eq("status", "interessado")
      .limit(1);

    if (!pendentes?.length) {
      await supabase
        .from("missoes")
        .update({ status: "aberta" })
        .eq("id", missaoId);
    }

    return sendText(phone, "Interessado recusado.");
  }

  // =====================
  // DONO: CRIAR MISSÃO
  // =====================

  if (text === "contratar_criar_missao") {
    await updateUser({
      etapa: "missao_titulo",
      missao_titulo: null,
      missao_desc: null,
      missao_valor_temp: null,
    });

    return sendText(phone, "Qual o título da missão?\nEx: Preciso de alguém para me ajudar com uma tarefa específica.");
  }

  if (user.etapa === "missao_titulo") {
    if (!text || text.length < 3) {
      return sendText(phone, "Digite um título válido para a missão:");
    }

    await updateUser({
      missao_titulo: text,
      etapa: "missao_desc",
    });

    return sendText(phone, "Agora descreva melhor o que precisa:");
  }

  if (user.etapa === "missao_desc") {
    if (!text || text.length < 5) {
      return sendText(phone, "Descreva melhor a missão:");
    }

    await updateUser({
      missao_desc: text,
      etapa: "missao_valor",
    });

    return sendText(phone, "Qual valor você deseja investir?\nEsse valor será dividido pela quantidade de vagas!");
  }

  if (user.etapa === "missao_valor") {
  const valor = Number(String(text).replace(",", "."));

  if (!valor || valor <= 0) {
    return sendText(phone, "Digite um valor válido.\nEx: 40");
  }

  await updateUser({
    etapa: "missao_tipo",
    missao_valor_temp: String(valor),
  });

  return sendActionButtons(
    phone,
    "Essa missão será:",
    [
      { id: "missao_tipo_individual", title: "Para 1 pessoa" },
      { id: "missao_tipo_campanha", title: "Para várias pessoas" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]
  );
}


if (user.etapa === "missao_tipo" && text === "missao_tipo_individual") {
  await updateUser({
    etapa: "missao_urgencia",
    missao_tipo_temp: "individual",
    vagas_total_temp: 1,
  });

  const valorBase = Number(user.missao_valor_temp || 0);
  const taxa = calcMissaoTaxa(valorBase);

  return sendActionButtons(
    phone,
    `Resumo:\n\nValor: R$ ${valorBase.toFixed(2)}\nTaxa: R$ ${taxa.toFixed(2)}\n\nAdicionar urgência?`,
    [
      { id: "missao_urgencia_sim", title: "Com urgência" },
      { id: "missao_urgencia_nao", title: "Sem urgência" },
    ]
  );
}

if (user.etapa === "missao_tipo" && text === "missao_tipo_campanha") {
  await updateUser({
    etapa: "missao_qtd_pessoas",
    missao_tipo_temp: "campanha",
  });

  return sendText(
    phone,
    "Quantas pessoas você quer atingir?\nEx: 10"
  );
}


if (user.etapa === "missao_qtd_pessoas") {
  const qtd = Number(text);

  if (!qtd || qtd <= 0) {
    return sendText(phone, "Digite um número válido.\nEx: 10");
  }

  await updateUser({
    etapa: "missao_resumo_campanha",
    vagas_total_temp: qtd,
  });

  const total = Number(user.missao_valor_temp || 0);
  const valorPorPessoa = total / qtd;

  await sendText(
    phone,
    `📊 *Resumo da campanha*\n\n` +
    `💰 Total: R$ ${total.toFixed(2)}\n` +
    `👥 Pessoas: ${qtd}\n` +
    `🎯 Por pessoa: R$ ${valorPorPessoa.toFixed(2)}`
  );

  return sendActionButtons(
    phone,
    "Deseja continuar?",
    [
      { id: "missao_confirmar_campanha", title: "Confirmar" },
      { id: "voltar_menu", title: "Cancelar" },
    ]
  );
}


if (user.etapa === "missao_resumo_campanha") {
  if (text === "missao_confirmar_campanha") {
    await updateUser({
      etapa: "missao_urgencia",
    });

    const valorBase = Number(user.missao_valor_temp || 0);
    const vagasTotal = Number(user.vagas_total_temp || 1);
    const valorPorPessoa = valorBase / vagasTotal;
    const taxa = calcMissaoTaxa(valorBase);

    return sendActionButtons(
      phone,
      `📊 *Campanha confirmada*\n\n` +
        `💰 Total: R$ ${valorBase.toFixed(2)}\n` +
        `👥 Pessoas: ${vagasTotal}\n` +
        `🎯 Por pessoa: R$ ${valorPorPessoa.toFixed(2)}\n` +
        `🧾 Taxa da plataforma: R$ ${taxa.toFixed(2)}\n\n` +
        `Quer adicionar urgência por +R$ 4,90?`,
      [
        { id: "missao_urgencia_sim", title: "Com urgência" },
        { id: "missao_urgencia_nao", title: "Sem urgência" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]
    );
  }

  if (text === "voltar_menu") {
    await updateUser({
      etapa: "menu",
      missao_titulo: null,
      missao_desc: null,
      missao_valor_temp: null,
      missao_tipo_temp: null,
      vagas_total_temp: null,
    });

    return sendText(phone, "Criação da campanha cancelada.");
  }

  return sendText(phone, "Escolha uma opção: Confirmar ou Cancelar.");
}

  if (
    user.etapa === "missao_urgencia" &&
    ["missao_urgencia_sim", "missao_urgencia_nao"].includes(text)
  ) {
    const urgencia = text === "missao_urgencia_sim";
    const valorBase = Number(user.missao_valor_temp || 0);
    const resumo = calcMissaoTotal(valorBase, urgencia);
    const categoria = inferCategoria(user.missao_desc || user.missao_titulo || "");

    const payment = await createPendingPayment(supabase, {
      usuarioId: user.id,
      referenciaTipo: "missao_publicacao",
      planoCodigo: urgencia ? "missao_urgencia" : null,
      valor: resumo.total,
     metadata: {
  titulo: user.missao_titulo,
  descricao: user.missao_desc,

  tipo: user.missao_tipo_temp || "individual",
  vagas_total: Number(user.vagas_total_temp || 1),
  valor_total: Number(user.missao_valor_temp || 0),
  valor_por_pessoa:
    user.missao_tipo_temp === "campanha"
      ? Number(user.missao_valor_temp || 0) / Number(user.vagas_total_temp || 1)
      : Number(user.missao_valor_temp || 0),

  valor_missao: resumo.valorMissao,
  taxa_plataforma: resumo.taxa,
  urgencia,
  categoria_chave: categoria,
  cidade: user.cidade,
  estado: user.estado,
},
    });

    if (!payment) {
      await sendText(phone, "Erro ao gerar cobrança da missão.");
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "contratar_criar_missao", title: "Tentar novamente" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    let intent = null;
    try {
      intent = await createMercadoPagoPixIntent(payment.id);
    } catch (err) {
      console.error("❌ erro ao gerar Pix da missão:", err);
    }

    await updateUser({
      etapa: "menu",
      missao_titulo: null,
      missao_desc: null,
      missao_valor_temp: null,
    });

    if (!intent) {
      await sendText(
        phone,
        `💳 Pedido criado com sucesso!\n\nMissão: ${
          payment.metadata?.titulo || "Missão"
        }\nValor da missão: R$ ${resumo.valorMissao.toFixed(
          2
        )}\nTaxa da plataforma: R$ ${resumo.taxa.toFixed(
          2
        )}\nUrgência: R$ ${resumo.urgencia.toFixed(
          2
        )}\nTotal: R$ ${resumo.total.toFixed(2)}\nPedido: ${
          payment.id
        }\n\nNão consegui gerar o Pix automaticamente agora, mas o pedido foi criado.`
      );

      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "contratar_criar_missao", title: "Criar outra missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    await sendText(phone, buildPixResumo(intent, resumo));
    await sendText(phone, `\n\n${buildPixCodeOnly(intent)}`);

    return sendActionButtons(phone, "Depois do pagamento:", [
      { id: "payment_check_status", title: "Já paguei" },
      { id: "contratar_minhas_missoes", title: "Minhas missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  // =====================
  // DONO: VER MINHAS MISSÕES
  // =====================

  if (text === "contratar_minhas_missoes") {
    const { data: missoes, error } = await supabase
      .from("missoes")
      .select("*")
      .eq("usuario_id", user.id)
      .order("created_at", { ascending: false })
      .limit(15);

    if (error) {
      console.error("❌ erro ao listar minhas missões:", error);
      return sendText(phone, "Erro ao buscar suas missões.");
    }

    if (!missoes?.length) {
      await sendText(phone, "Você ainda não criou nenhuma missão.");
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: "contratar_criar_missao", title: "Criar missão" },
        { id: "voltar_menu", title: "Voltar ao menu" },
      ]);
    }

    return sendList(phone, "Escolha uma missão:", [
      {
        title: "Minhas missões",
        rows: missoes.map((m) => ({
          id: `minha_missao_${m.id}`,
          title: m.titulo.slice(0, 24),
          description: `${statusLabel(m.status)} - R$ ${money(getValorRecompensa(m))} por pessoa`.slice(0, 72),
        })),
      },
    ]);
  }

  if (text.startsWith("minha_missao_")) {
    const missaoId = text.replace("minha_missao_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) {
      return sendText(phone, "Missão não encontrada.");
    }

 await sendText(
  phone,
  buildMissaoPublicaDetalhe(missao, user.nome || "Você")
);
    if (missao.status === "aberta" || missao.status === "aguardando_aprovacao_dono") {
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: `missao_ver_interessados_${missao.id}`, title: "Ver interessados" },
        { id: `missao_cancelar_${missao.id}`, title: "Cancelar missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
      ]);
    }

    if (missao.status === "em_andamento") {
      return sendActionButtons(phone, "O que deseja fazer agora?", [
        { id: `missao_dono_concluir_${missao.id}`, title: "Marcar finalizada" },
        { id: `missao_cancelar_${missao.id}`, title: "Cancelar missão" },
        { id: "contratar_minhas_missoes", title: "Minhas missões" },
      ]);
    }

    return sendActionButtons(phone, "O que deseja fazer agora?", [
      { id: "contratar_minhas_missoes", title: "Minhas missões" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  if (text.startsWith("missao_ver_interessados_")) {
    const missaoId = text.replace("missao_ver_interessados_", "");

    const { data: interessados } = await supabase
      .from("missoes_interessados")
      .select("id,usuario_id,status")
      .eq("missao_id", missaoId)
      .in("status", ["interessado", "aceito", "em_andamento", "concluida"])
      .limit(10);

    if (!interessados?.length) {
      return sendText(phone, "Ainda não há interessados nessa missão.");
    }

    const usuariosIds = interessados.map((i) => i.usuario_id);
    const { data: usuarios } = await supabase
      .from("usuarios")
      .select("id,nome,telefone")
      .in("id", usuariosIds);

    const rows = interessados.map((i) => {
      const u = (usuarios || []).find((x) => x.id === i.usuario_id);
      return {
        id: `missao_aprovar_${missaoId}_${i.usuario_id}`,
        title: (u?.nome || "Usuário").slice(0, 24),
        description: (u?.telefone || "Sem telefone").slice(0, 72),
      };
    });

    return sendList(phone, "Escolha um interessado para aceitar:", [
      {
        title: "Interessados",
        rows,
      },
    ]);
  }

  if (text.startsWith("missao_cancelar_")) {
    const missaoId = text.replace("missao_cancelar_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    if (missao.status === "em_andamento") {
      await sendText(
        phone,
        "Essa missão já está em andamento. O cancelamento exige motivo e a taxa da plataforma não será devolvida."
      );
      await updateUser({
        etapa: `missao_cancelar_motivo_${missaoId}`,
        missao_cancelamento_motivo_temp: null,
      });
      return sendText(phone, "Informe o motivo do cancelamento:");
    }

    await updateUser({
      etapa: `missao_cancelar_motivo_${missaoId}`,
      missao_cancelamento_motivo_temp: null,
    });

    return sendText(phone, "Informe o motivo do cancelamento:");
  }

  if (user.etapa?.startsWith("missao_cancelar_motivo_")) {
    const missaoId = user.etapa.replace("missao_cancelar_motivo_", "");

    if (!text || text.length < 3) {
      return sendText(phone, "Informe um motivo válido:");
    }

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) {
      await updateUser({ etapa: "menu" });
      return sendText(phone, "Missão não encontrada.");
    }
const devolucao = await devolverSaldoMissaoCancelada({
  supabase,
  missao,
});

await supabase
  .from("missoes")
  .update({
    status: "cancelada",
    motivo_cancelamento: text,
    cancelada_em: new Date().toISOString(),
  })
  .eq("id", missaoId);

    await updateUser({
      etapa: "menu",
      missao_cancelamento_motivo_temp: null,
    });

   return sendText(
  phone,
  `✅ Missão cancelada.\n\n` +
    `💰 Valor devolvido para sua carteira: R$ ${money(devolucao.valorDevolver)}\n` +
    `🧾 Taxa retida: R$ ${money(devolucao.taxaRetida)}`
);
  }

  // =====================
  // CONCLUSÃO
  // =====================

  if (text.startsWith("missao_executor_concluir_")) {
  const missaoId = text.replace("missao_executor_concluir_", "");

  const { data: missao } = await supabase
    .from("missoes")
    .select("*")
    .eq("id", missaoId)
    .maybeSingle();

  if (!missao) return sendText(phone, "Missão não encontrada.");

  const { data: relacao } = await supabase
    .from("missoes_interessados")
    .select("*")
    .eq("missao_id", missaoId)
    .eq("usuario_id", user.id)
    .in("status", ["aceito", "em_andamento"])
    .maybeSingle();

  if (!relacao && missao.executor_usuario_id !== user.id) {
    return sendText(phone, "Essa missão não está vinculada a você.");
  }

  await supabase
    .from("missoes_interessados")
    .update({
      status: "concluida",
      concluido: true,
    })
    .eq("missao_id", missaoId)
    .eq("usuario_id", user.id);

  const { data: dono } = await supabase
    .from("usuarios")
    .select("telefone")
    .eq("id", missao.usuario_id)
    .maybeSingle();

  if (dono?.telefone) {
    await sendActionButtons(
      dono.telefone,
      `📦 O executor informou que concluiu a missão "${missao.titulo}".\n\n` +
        `👤 Executor: ${user.nome || user.telefone}\n` +
        `💰 Valor a liberar: R$ ${money(getValorRecompensa(missao))}`,
      [
        { id: `missao_dono_confirmar_${missao.id}_${user.id}`, title: "Confirmar" },
        { id: `missao_dono_negar_${missao.id}_${user.id}`, title: "Negar" },
        { id: "voltar_menu", title: "Voltar" },
      ]
    );
  }

  return sendText(phone, "✅ Sua conclusão foi enviada ao dono da missão.");
}
  if (text.startsWith("missao_dono_concluir_")) {
    const missaoId = text.replace("missao_dono_concluir_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    await supabase
      .from("missoes")
      .update({
        dono_confirmou_conclusao: true,
        status: "aguardando_confirmacao_executor",
      })
      .eq("id", missaoId);

    const { data: executor } = await supabase
      .from("usuarios")
      .select("telefone")
      .eq("id", missao.executor_usuario_id)
      .maybeSingle();

    if (executor?.telefone) {
      await sendActionButtons(
        executor.telefone,
        `📦 O dono informou que a missão "${missao.titulo}" foi finalizada.`,
        [
          { id: `missao_executor_confirmar_${missao.id}`, title: "Confirmar conclusão" },
          { id: `missao_executor_negar_${missao.id}`, title: "Ainda não concluí" },
          { id: "voltar_menu", title: "Voltar ao menu" },
        ]
      );
    }

    return sendText(phone, "✅ Seu aviso de finalização foi enviado ao executor.");
  }

  if (text.startsWith("missao_dono_confirmar_")) {
  const parts = text.split("_");
  const missaoId = parts[3];
  const executorId = parts[4];

  const { data: missao } = await supabase
    .from("missoes")
    .select("*")
    .eq("id", missaoId)
    .eq("usuario_id", user.id)
    .maybeSingle();

  if (!missao) return sendText(phone, "Missão não encontrada.");

  if (!executorId) return sendText(phone, "Executor não identificado.");

  await supabase
    .from("missoes_interessados")
    .update({
      status: "concluida",
      concluido: true,
      pago: true,
      pago_em: new Date().toISOString(),
    })
    .eq("missao_id", missaoId)
    .eq("usuario_id", executorId);

  await creditarMissaoNaCarteira({
    supabase,
    usuarioId: executorId,
    missao,
  });
await descontarReservaDoDono({
  supabase,
  missao,
});
  const { data: executor } = await supabase
    .from("usuarios")
    .select("id,telefone,nome")
    .eq("id", executorId)
    .maybeSingle();

  if (executor?.telefone) {
    await sendText(
      executor.telefone,
      `🎉 *Missão aprovada!*\n\n` +
        `Valor bruto: R$ ${money(getValorBrutoRecompensa(missao))}\n` +
`Taxa da plataforma: R$ ${money(getTaxaExecutor(missao))}\n` +
`Você recebeu: *R$ ${money(getValorRecompensa(missao))}*\n\n` +
        `📌 ${missao.titulo}`
    );

    await sendActionButtons(executor.telefone, "Deseja ver seu saldo?", [
      { id: "user_carteira", title: "Ver saldo" },
      { id: "voltar_menu", title: "Voltar ao menu" },
    ]);
  }

  const { data: missaoAtualizada } = await supabase
    .from("missoes")
    .select("*")
    .eq("id", missaoId)
    .maybeSingle();

  return sendText(
    phone,
    `✅ Conclusão confirmada.\n\n` +
      `💰 Valor bruto liberado: R$ ${money(getValorBrutoRecompensa(missao))}\n` +
`🧾 Taxa do executor: R$ ${money(getTaxaExecutor(missao))}\n` +
`👤 Executor recebeu: R$ ${money(getValorRecompensa(missao))}\n` +
      `👥 Vagas restantes: ${getVagasRestantes(missaoAtualizada || missao)}`
  );
}

  if (text.startsWith("missao_executor_confirmar_")) {
    const missaoId = text.replace("missao_executor_confirmar_", "");

    const { data: missao } = await supabase
      .from("missoes")
      .select("*")
      .eq("id", missaoId)
      .eq("executor_usuario_id", user.id)
      .maybeSingle();

    if (!missao) return sendText(phone, "Missão não encontrada.");

    const novosDados = { executor_confirmou_conclusao: true };
    const status = missao.dono_confirmou_conclusao
      ? "concluida"
      : "aguardando_confirmacao_dono";

    novosDados.status = status;
    if (status === "concluida") {
      novosDados.concluida_em = new Date().toISOString();
    }

    await supabase.from("missoes").update(novosDados).eq("id", missaoId);

    if (status === "concluida") {
      return sendText(phone, "✅ Missão concluída com sucesso e removida da lista pública.");
    }

    return sendText(phone, "✅ Sua confirmação foi registrada.");
  }

  if (text.startsWith("missao_dono_negar_") || text.startsWith("missao_executor_negar_")) {
    return sendText(phone, "Entendido. A missão continua em andamento até nova confirmação.");
  }

  return false;
}
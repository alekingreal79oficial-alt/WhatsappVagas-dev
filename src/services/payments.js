import crypto from "crypto";
import { supabase } from "../supabase.js";

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

function ensureMpToken() {
  if (!MP_TOKEN) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado.");
  }
}

function buildIdempotencyKey(prefix, id) {
  return `${prefix}_${id}`;
}

async function mpFetch(path, options = {}) {
  ensureMpToken();

  const headers = {
    Authorization: `Bearer ${MP_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const res = await fetch(`${MP_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error("❌ Mercado Pago error:", res.status, data);
    throw new Error(`Mercado Pago ${res.status}`);
  }

  return data;
}

export async function getPendingPaymentById(paymentId) {
  const { data, error } = await supabase
    .from("pagamentos_plataforma")
    .select("*")
    .eq("id", paymentId)
    .maybeSingle();

  if (error) {
    console.error("❌ erro ao buscar pagamento:", error);
    return null;
  }

  return data || null;
}

export async function updatePayment(paymentId, data) {
  const { data: updated, error } = await supabase
    .from("pagamentos_plataforma")
    .update(data)
    .eq("id", paymentId)
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao atualizar pagamento:", error);
    return null;
  }

  return updated;
}

export async function markPaymentAsPaid(paymentId, extra = {}) {
  return updatePayment(paymentId, {
    status: "pago",
    pago_em: new Date().toISOString(),
    ...extra,
  });
}

export async function markPaymentAsCancelled(paymentId, extra = {}) {
  return updatePayment(paymentId, {
    status: "cancelado",
    ...extra,
  });
}

function buildNotificationUrl() {
  if (!PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL não configurado.");
  }

  return `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/payments/webhook`;
}

function buildPixDescription(payment) {
  const md = payment.metadata || {};

  if (md.titulo) return md.titulo;
  if (payment.plano_codigo) return `Pagamento ${payment.plano_codigo}`;
  return `Pagamento plataforma ${payment.id}`;
}

async function buildPayerEmail(payment) {
  const { data: usuario, error } = await supabase
    .from("usuarios")
    .select("email")
    .eq("id", payment.usuario_id)
    .maybeSingle();

  if (error) {
    console.error("❌ erro ao buscar email do usuário:", error);
  }

  const email = usuario?.email;

  if (
    email &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim().toLowerCase())
  ) {
    return String(email).trim().toLowerCase();
  }

  const safeUserId = String(payment.usuario_id || "guest")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40);

  return `${safeUserId}@example.com`;
}

export async function createMercadoPagoPixIntent(paymentId) {
  const payment = await getPendingPaymentById(paymentId);

  if (!payment) return null;

  if (payment.status !== "pendente") {
    return payment;
  }

  if (payment.mp_payment_id && payment.qr_code) {
    return payment;
  }

  const body = {
    transaction_amount: Number(payment.valor),
    description: buildPixDescription(payment),
    payment_method_id: "pix",
    notification_url: buildNotificationUrl(),
    external_reference: payment.id,
    payer: {
      email: await buildPayerEmail(payment),
    },
    metadata: {
      plataforma_payment_id: payment.id,
      referencia_tipo: payment.referencia_tipo,
      usuario_id: payment.usuario_id,
      ...(payment.metadata || {}),
    },
  };

  const mpData = await mpFetch("/v1/payments", {
    method: "POST",
    headers: {
      "X-Idempotency-Key": buildIdempotencyKey("pix", payment.id),
    },
    body: JSON.stringify(body),
  });

  const qrData = mpData?.point_of_interaction?.transaction_data || {};

  const updated = await updatePayment(payment.id, {
    mp_payment_id: String(mpData.id),
    status: "pendente",
    qr_code: qrData.qr_code || null,
    qr_code_base64: qrData.qr_code_base64 || null,
    checkout_url: qrData.ticket_url || null,
    metadata: {
      ...(payment.metadata || {}),
      mercado_pago_status: mpData.status || null,
      mercado_pago_status_detail: mpData.status_detail || null,
    },
  });

  return updated;
}

export async function getMercadoPagoPayment(mpPaymentId) {
  if (!mpPaymentId) return null;

  return mpFetch(`/v1/payments/${mpPaymentId}`, {
    method: "GET",
  });
}

export function verifyMercadoPagoWebhookSignature(req) {
  if (!MP_WEBHOOK_SECRET) {
    return true;
  }

  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"] || "";
  const dataId = req.query["data.id"] || req.body?.data?.id || "";

  if (!signature || !dataId) {
    return false;
  }

  const parts = String(signature)
    .split(",")
    .map((p) => p.trim());

  const tsPart = parts.find((p) => p.startsWith("ts="));
  const v1Part = parts.find((p) => p.startsWith("v1="));

  if (!tsPart || !v1Part) {
    return false;
  }

  const ts = tsPart.replace("ts=", "");
  const v1 = v1Part.replace("v1=", "");

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

  const expected = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  return expected === v1;
}

/**
 * Assinaturas recorrentes que ainda fazem sentido:
 * - trabalhador semanal
 * - trabalhador mensal/notificações
 */
export async function activateSubscriptionFromPayment(payment) {
  if (!payment?.usuario_id) return null;

  const now = new Date();
  const fim = new Date(now);
  const md = payment.metadata || {};

  let tipo = null;
  let dias = 0;

  if (payment.referencia_tipo === "usuario_vagas_semanal") {
    tipo = "usuario_vagas_semanal";
    dias = 7;
  }

  if (payment.referencia_tipo === "usuario_alerta_mensal") {
    tipo = "usuario_alerta_mensal";
    dias = 30;
  }

  if (!tipo || !dias) return null;

  fim.setDate(fim.getDate() + dias);

  const notificacaoScope = md.notificacao_scope || "categoria_atual";
  const categoriasExtras = Array.isArray(md.categorias_extras)
    ? md.categorias_extras
    : [];

  const { data, error } = await supabase
    .from("assinaturas_usuario")
    .insert({
      usuario_id: payment.usuario_id,
      tipo,
      status: "ativa",
      inicio_em: now.toISOString(),
      fim_em: fim.toISOString(),
      notificacao_scope: notificacaoScope,
      categorias_extras: categoriasExtras,
    })
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao ativar assinatura:", error);
    return null;
  }

  return data;
}

/**
 * Créditos de publicação de vagas da empresa
 */
export async function activateCompanyJobCreditsFromPayment(payment) {
  if (!payment?.usuario_id) return null;

  let totalCreditos = 0;
  const dias = 30;

  if (payment.plano_codigo === "empresa_1_vaga") totalCreditos = 1;
  if (payment.plano_codigo === "empresa_3_vagas") totalCreditos = 3;
  if (payment.plano_codigo === "empresa_10_vagas") totalCreditos = 10;

  if (!totalCreditos) return null;

  const validade = new Date();
  validade.setDate(validade.getDate() + dias);

  const { data, error } = await supabase
    .from("empresa_creditos_vagas")
    .insert({
      empresa_id: payment.usuario_id,
      pagamento_id: payment.id,
      plano_codigo: payment.plano_codigo,
      total_creditos: totalCreditos,
      creditos_usados: 0,
      status: "ativo",
      validade_em: validade.toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao ativar créditos de vagas da empresa:", error);
    return null;
  }

  return data;
}

export async function getActiveCompanyJobCredits(empresaId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("empresa_creditos_vagas")
    .select("*")
    .eq("empresa_id", empresaId)
    .eq("status", "ativo")
    .gt("validade_em", now)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("❌ erro ao buscar créditos ativos da empresa:", error);
    return [];
  }

  return data || [];
}

export async function consumeCompanyJobCredit(empresaId) {
  const credits = await getActiveCompanyJobCredits(empresaId);

  const credit = credits.find(
    (c) => Number(c.creditos_usados || 0) < Number(c.total_creditos || 0)
  );

  if (!credit) return null;

  const novosUsados = Number(credit.creditos_usados || 0) + 1;
  const novoStatus =
    novosUsados >= Number(credit.total_creditos || 0) ? "esgotado" : "ativo";

  const { data, error } = await supabase
    .from("empresa_creditos_vagas")
    .update({
      creditos_usados: novosUsados,
      status: novoStatus,
    })
    .eq("id", credit.id)
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao consumir crédito de vaga:", error);
    return null;
  }

  return data;
}

/**
 * Missões
 */
export async function publishMissionFromPayment(payment) {
  if (payment.referencia_tipo !== "missao_publicacao") return null;

  const md = payment.metadata || {};

  const { data, error } = await supabase
    .from("missoes")
    .insert({
      usuario_id: payment.usuario_id,
      titulo: md.titulo,
      descricao: md.descricao,
      categoria_chave: md.categoria_chave,
      tipo: md.tipo || "individual",
vagas_total: Number(md.vagas_total || 1),
vagas_ocupadas: 0,
valor_total: Number(md.valor_total || md.valor_missao || 0),
valor_por_pessoa: Number(md.valor_por_pessoa || md.valor_missao || 0),

valor: Number(md.valor_missao || md.valor_por_pessoa || 0),
taxa_plataforma: md.taxa_plataforma || 0,
      urgencia: !!md.urgencia,
      cidade: md.cidade,
      estado: md.estado,
      status: "aberta",
      pagamento_status: "retido",
    })
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao publicar missão a partir do pagamento:", error);
    return null;
  }

  return data;
}

/**
 * Vagas pagas individualmente.
 * No modelo atual da empresa, a publicação normal acontece por crédito.
 * Mantemos essa função por compatibilidade caso ainda exista algum fluxo legado.
 */
export async function publishJobFromPayment(payment) {
  if (payment.referencia_tipo !== "empresa_publicar_vaga") return null;

  if (payment.status !== "pago") {
    console.log("⛔ tentativa de publicar vaga sem pagamento aprovado");
    return null;
  }

  const md = payment.metadata || {};

  const { data: existing } = await supabase
    .from("vagas")
    .select("id")
    .eq("empresa_id", payment.usuario_id)
    .eq("titulo", md.titulo || "")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.log("ℹ️ vaga já existe, não duplicando");
    return existing;
  }

  const { data, error } = await supabase
    .from("vagas")
    .insert({
      empresa_id: payment.usuario_id,
      nome_empresa: md.nome_empresa || null,
      titulo: md.titulo,
      descricao: md.descricao,
      requisitos: md.requisitos,
      tipo_contratacao: md.tipo_contratacao,
      salario: md.salario,
      jornada: md.jornada,
      quantidade_vagas: md.quantidade_vagas || 1,
      categoria_chave: md.categoria_chave,
      cidade: md.cidade,
      estado: md.estado,
      destaque: !!md.destaque,
      status: "ativa",
      publicada_em: new Date().toISOString(),
      contato_whatsapp: md.contato_whatsapp || null,
    })
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao publicar vaga:", error);
    return null;
  }

  return data;
}

/**
 * Publicação do profissional em "servicos"
 */
export async function publishProfessionalServiceFromPayment(payment) {
  if (payment.referencia_tipo !== "profissional_anuncio") return null;
  if (payment.status !== "pago") return null;

  const md = payment.metadata || {};

  const { data: usuario } = await supabase
    .from("usuarios")
    .select("nome, telefone, cidade, estado, categoria_principal")
    .eq("id", payment.usuario_id)
    .maybeSingle();

  const categoriaChave =
    md.categoria_chave || usuario?.categoria_principal || null;

  const tituloBase = md.titulo || usuario?.nome || "Profissional";
  const descricaoBase =
    md.descricao ||
    "Profissional disponível para oportunidades e prestação de serviço.";

  const { data: existing } = await supabase
    .from("servicos")
    .select("id")
    .eq("usuario_id", payment.usuario_id)
    .eq("categoria_chave", categoriaChave)
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.log("ℹ️ anúncio profissional já existe, não duplicando");
    return existing;
  }

  const { data, error } = await supabase
    .from("servicos")
    .insert({
      usuario_id: payment.usuario_id,
      titulo: tituloBase,
      descricao: descricaoBase,
      categoria_chave: categoriaChave,
      cidade: md.cidade || usuario?.cidade || null,
      estado: md.estado || usuario?.estado || null,
      contato_whatsapp: md.contato_whatsapp || usuario?.telefone || null,
      ativo: true,
      nivel_visibilidade: 0,
    })
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao publicar anúncio profissional:", error);
    return null;
  }

  return data;
}

/**
 * Destaque profissional:
 * eleva a visibilidade do último anúncio ativo do usuário.
 */
export async function applyProfessionalHighlightFromPayment(payment) {
  if (payment.referencia_tipo !== "profissional_destaque") return null;
  if (payment.status !== "pago") return null;

  const { data: servico, error: findError } = await supabase
    .from("servicos")
    .select("*")
    .eq("usuario_id", payment.usuario_id)
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    console.error("❌ erro ao localizar serviço para destaque:", findError);
    return null;
  }

  if (!servico) {
    console.log("ℹ️ nenhum anúncio ativo encontrado para destacar");
    return null;
  }

  const novoNivel = Math.max(Number(servico.nivel_visibilidade || 0), 1);
const md = payment.metadata || {};
const dias = Number(md.dias_destaque || 30);
const destaqueAte = new Date();
destaqueAte.setDate(destaqueAte.getDate() + dias);
  const { data, error } = await supabase
    .from("servicos")
   .update({
  nivel_visibilidade: novoNivel,
  destaque_ate: destaqueAte.toISOString(),
})
    .eq("id", servico.id)
    .select()
    .single();

  if (error) {
    console.error("❌ erro ao aplicar destaque profissional:", error);
    return null;
  }

  return data;
}
async function ensureCarteira(usuarioId) {
  const { data: existente } = await supabase
    .from("carteiras")
    .select("*")
    .eq("usuario_id", usuarioId)
    .maybeSingle();

  if (existente) return existente;

  const { data } = await supabase
    .from("carteiras")
    .insert({
      usuario_id: usuarioId,
      saldo: 0,
      saldo_pendente: 0,
    })
    .select()
    .single();

  return data;
}
export async function processApprovedMercadoPagoPayment(mpPaymentId) {
  const mpPayment = await getMercadoPagoPayment(mpPaymentId);

  if (!mpPayment) return null;

  if (mpPayment.status !== "approved") {
    console.log("⏳ pagamento ainda não aprovado no Mercado Pago:", {
      id: mpPayment.id,
      status: mpPayment.status,
      status_detail: mpPayment.status_detail,
    });
    return null;
  }

  const internalPaymentId =
    mpPayment.external_reference ||
    mpPayment.metadata?.plataforma_payment_id ||
    null;

  if (!internalPaymentId) {
    console.error("❌ pagamento Mercado Pago sem external_reference interno.");
    return null;
  }

  const internalPayment = await getPendingPaymentById(internalPaymentId);
  if (!internalPayment) return null;

  // Se já está pago internamente, não reaplica efeitos
  if (internalPayment.status === "pago") {
    return internalPayment;
  }

  const paid = await markPaymentAsPaid(internalPayment.id, {
    mp_payment_id: String(mpPayment.id),
    metadata: {
      ...(internalPayment.metadata || {}),
      mercado_pago_status: mpPayment.status,
      mercado_pago_status_detail: mpPayment.status_detail || null,
    },
  });

  if (!paid) return null;

  await activateSubscriptionFromPayment(paid);
  
  await activateCompanyJobCreditsFromPayment(paid);
  if (paid.referencia_tipo === "usuario_vagas_avulso_24h") {
  const unlockAte = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await supabase
    .from("usuarios")
    .update({ vagas_unlock_ate: unlockAte })
    .eq("id", paid.usuario_id);
}
  if (paid.referencia_tipo === "missao_publicacao") {
  const md = paid.metadata || {};

  const valorBloqueado = Number(paid.valor || 0);

const carteira = await ensureCarteira(paid.usuario_id);

await supabase
  .from("carteiras")
  .update({
    saldo_pendente: Number(carteira.saldo_pendente || 0) + valorBloqueado,
  })
  .eq("usuario_id", paid.usuario_id);

await publishMissionFromPayment(paid);

console.log("💰 valor bloqueado para missão:", valorBloqueado);
  }
  await publishJobFromPayment(paid);
  await publishProfessionalServiceFromPayment(paid);
  await applyProfessionalHighlightFromPayment(paid);

  return paid;
}
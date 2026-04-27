import { supabase } from "./supabase.js";
import { sendText } from "./services/whatsapp.js";
import {
  sendRootMenu,
  sendMenuUsuario,
  sendMenuContratante,
  sendMenuEmpresa,
} from "./flows/menus.js";
import { handleOnboarding } from "./flows/onboarding.js";
import { handleJobsMenu, handleUserFallback } from "./flows/jobs.js";
import { handleAdminMenu } from "./flows/admin.js";
import {
  handleServicesMenu,
  handleContratanteFallback,
} from "./flows/services.js";
import { handleMissions } from "./flows/missions.js";
import {
  handleCompanyMenu,
  handleCompanyFallback,
} from "./flows/company.js";
import {
  getPendingPaymentById,
  getMercadoPagoPayment,
  processApprovedMercadoPagoPayment,
} from "./services/payments.js";

const processingUsers = new Set();

async function getCategorias(contexto) {
  const { data, error } = await supabase
    .from("categorias")
    .select("*")
    .eq("contexto", contexto)
    .eq("ativo", true)
    .order("nome");

  if (error) {
    console.error("❌ erro getCategorias:", error);
    return [];
  }

  return data || [];
}

async function getCategoriasPorGrupos(contexto, grupos = []) {
  if (!grupos.length) return [];

  const { data, error } = await supabase
    .from("categorias")
    .select("*")
    .eq("contexto", contexto)
    .in("grupo", grupos)
    .eq("ativo", true)
    .order("nome");

  if (error) {
    console.error("❌ erro getCategoriasPorGrupos:", error);
    return [];
  }

  return data || [];
}

function getMenuByTipo(tipo, phone) {
  if (tipo === "empresa") return sendMenuEmpresa(phone);
  if (tipo === "contratante") return sendMenuContratante(phone);
  return sendMenuUsuario(phone);
}

async function getLastUserPayment(userId) {
  const { data, error } = await supabase
    .from("pagamentos_plataforma")
    .select("*")
    .eq("usuario_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ erro ao buscar último pagamento:", error);
    return null;
  }

  return data || null;
}

async function handlePaymentCheckStatus(user, phone) {
  const payment = await getLastUserPayment(user.id);

  if (!payment) {
    return sendText(phone, "Nenhum pagamento recente encontrado.");
  }

  if (payment.mp_payment_id) {
    try {
      const mpStatus = await getMercadoPagoPayment(payment.mp_payment_id);

      if (mpStatus?.status === "approved") {
        await processApprovedMercadoPagoPayment(String(payment.mp_payment_id));

        const updated = await getPendingPaymentById(payment.id);

        return sendText(
          phone,
          `✅ Pagamento confirmado!\n\nPedido: ${updated?.id || payment.id}`
        );
      }

      return sendText(
        phone,
        `⏳ Pagamento pendente\nStatus: ${mpStatus?.status || "pendente"}`
      );
    } catch (err) {
      console.error("❌ erro MP:", err);

      return sendText(
        phone,
        "⏳ Ainda não consegui confirmar seu pagamento."
      );
    }
  }

  return sendText(
    phone,
    `⏳ Pedido criado, aguardando pagamento.\nID: ${payment.id}`
  );
}

export async function handleMessage(msg) {
  
  const phone = msg?.from;
  if (!phone) return;

  if (processingUsers.has(phone)) {
    console.log("⏳ ignorado:", phone);
    return;
  }

  processingUsers.add(phone);

  try {
    const text =
      msg?.interactive?.button_reply?.id ||
      msg?.interactive?.list_reply?.id ||
      msg?.text?.body?.toLowerCase().trim() ||
      "";

    let { data: user } = await supabase
      .from("usuarios")
      .select("*")
      .eq("telefone", phone)
      .maybeSingle();

    if (!user) {
      const { data: created } = await supabase
        .from("usuarios")
        .insert({
          telefone: phone,
          tipo: "usuario",
          etapa: "tipo",
          ativo: true,
          onboarding_finalizado: false,
        })
        .select()
        .single();

      user = created;
      return sendRootMenu(phone);
    }

    const updateUser = async (data) => {
      const { data: updated } = await supabase
        .from("usuarios")
        .update(data)
        .eq("id", user.id)
        .select()
        .single();

      Object.assign(user, updated);
      return updated;
    };
const isAdmin = user?.tipo_admin === true;

if (isAdmin) {
  const adminResponse = await handleAdminMenu({
    user,
    text,
    phone,
    supabase,
    updateUser,
  });

  if (adminResponse) return adminResponse;
}
    // =====================
    // COMANDOS GLOBAIS
    // =====================

    if (["oi", "menu", "inicio", "início"].includes(text)) {
      if (user.onboarding_finalizado) {
        return getMenuByTipo(user.tipo, phone);
      }
      return sendRootMenu(phone);
    }

    if (text === "voltar_menu") {
      return getMenuByTipo(user.tipo, phone);
    }

    if (text === "payment_check_status") {
      return handlePaymentCheckStatus(user, phone);
    }

    if (text === "redefinir_perfil") {
      await updateUser({
        etapa: "tipo",
        onboarding_finalizado: false,
        area_principal: null,
        categoria_principal: null,
        subcategorias_temp: [],
        raio_km: 20,
      });

      return sendRootMenu(phone);
    }

    // =====================
    // ONBOARDING
    // =====================

    const onboardingResponse = await handleOnboarding({
      user,
      text,
      phone,
      supabase,
      updateUser,
      getCategorias,
      getCategoriasPorGrupos,
    });

    if (onboardingResponse) return onboardingResponse;

    // =====================
    // USUÁRIO
    // =====================

    if (user.tipo === "usuario") {
      const jobs = await handleJobsMenu({
  user,
  text,
  phone,
  supabase,
  updateUser,
});
      if (jobs) return jobs;

      const missions = await handleMissions({
        user,
        text,
        phone,
        supabase,
        updateUser,
      });
      if (missions) return missions;

      return handleUserFallback(phone);
    }

    // =====================
    // CONTRATANTE
    // =====================

    if (user.tipo === "contratante") {
      const services = await handleServicesMenu({
        user,
        text,
        phone,
        supabase,
        updateUser,
        getCategorias,
        getCategoriasPorGrupos,
      });
      if (services) return services;

      const missions = await handleMissions({
        user,
        text,
        phone,
        supabase,
        updateUser,
      });
      if (missions) return missions;

      return handleContratanteFallback(phone);
    }

    // =====================
    // EMPRESA
    // =====================

    if (user.tipo === "empresa") {
  const company = await handleCompanyMenu({
    user,
    text,
    phone,
    supabase,
    updateUser,
    getCategorias,
    getCategoriasPorGrupos,
  });

  if (company) return company;

  const missions = await handleMissions({
    user,
    text,
    phone,
    supabase,
    updateUser,
  });

  if (missions) return missions;

  return handleCompanyFallback(phone);
}

    return sendRootMenu(phone);
  } catch (err) {
    console.error("❌ erro geral:", err);
    return sendText(phone, "Erro ao processar mensagem.");
  } finally {
    processingUsers.delete(phone);
  }
}
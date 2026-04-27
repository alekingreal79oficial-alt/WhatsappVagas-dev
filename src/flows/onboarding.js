import { sendText, sendList } from "../services/whatsapp.js";
import { parseCidadeEstado, estadosRows } from "../lib/location.js";
import {
  sendMenuUsuario,
  sendMenuContratante,
  sendMenuEmpresa,
  sendActionButtons,
  sendAreasPage,
} from "./menus.js";
import {
  getSubcategoriasByCategoria,
  replaceUserSubcategorias,
} from "../lib/subcategories.js";

function isValidEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value).trim().toLowerCase()
  );
}

function cleanCPF(cpf = "") {
  return String(cpf).replace(/\D/g, "");
}

function isValidCPF(cpf = "") {
  cpf = cleanCPF(cpf);

  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }

  let firstDigit = (sum * 10) % 11;
  if (firstDigit === 10) firstDigit = 0;
  if (firstDigit !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }

  let secondDigit = (sum * 10) % 11;
  if (secondDigit === 10) secondDigit = 0;

  return secondDigit === Number(cpf[10]);
}
function cleanCNPJ(cnpj = "") {
  return String(cnpj).replace(/\D/g, "");
}

function isValidCNPJ(cnpj = "") {
  cnpj = cleanCNPJ(cnpj);

  if (!cnpj || cnpj.length !== 14) return false;
  if (/^(\d)\1+$/.test(cnpj)) return false;

  const calcDigit = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += Number(base[i]) * weights[i];
    }

    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const d1 = calcDigit(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calcDigit(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

function shortTitle(value = "") {
  const text = String(value || "").trim();
  return text.length > 24 ? `${text.slice(0, 21)}...` : text;
}
const UF_SET = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

const ESTADO_NOME_TO_UF = {
  acre: "AC",
  alagoas: "AL",
  amapa: "AP",
  amapá: "AP",
  amazonas: "AM",
  bahia: "BA",
  ceara: "CE",
  ceará: "CE",
  "distrito federal": "DF",
  espirito_santo: "ES",
  "espírito santo": "ES",
  espirito: "ES",
  espírito: "ES",
  goias: "GO",
  goiás: "GO",
  maranhao: "MA",
  maranhão: "MA",
  mato_grosso: "MT",
  "mato grosso": "MT",
  mato_grosso_do_sul: "MS",
  "mato grosso do sul": "MS",
  minas_gerais: "MG",
  "minas gerais": "MG",
  para: "PA",
  pará: "PA",
  paraiba: "PB",
  paraíba: "PB",
  parana: "PR",
  paraná: "PR",
  pernambuco: "PE",
  piaui: "PI",
  piauí: "PI",
  rio_de_janeiro: "RJ",
  "rio de janeiro": "RJ",
  rio_grande_do_norte: "RN",
  "rio grande do norte": "RN",
  rio_grande_do_sul: "RS",
  "rio grande do sul": "RS",
  rondonia: "RO",
  rondônia: "RO",
  roraima: "RR",
  santa_catarina: "SC",
  "santa catarina": "SC",
  sao_paulo: "SP",
  "são paulo": "SP",
  sergipe: "SE",
  tocantins: "TO",
};

function normalizeEstadoInput(value = "") {
  const raw = String(value).trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (UF_SET.has(upper)) return upper;

  const normalized = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

  return ESTADO_NOME_TO_UF[normalized] || null;
}

async function getAreasAtivas(supabase) {
  // 1) Busca correta na tabela public.areas
  const { data, error } = await supabase
    .schema("public")
    .from("areas")
    .select("chave,nome,ativo")
    .eq("ativo", true)
    .order("nome", { ascending: true });

  console.log("🧪 BUSCA public.areas:", { data, error });

  if (!error && Array.isArray(data) && data.length > 0) {
    return data;
  }

  // 2) Plano B: caso o ambiente não aceite schema("public")
  const fallback = await supabase
    .from("areas")
    .select("chave,nome,ativo")
    .eq("ativo", true)
    .order("nome", { ascending: true });

  console.log("🧪 BUSCA areas fallback:", fallback);

  if (!fallback.error && Array.isArray(fallback.data) && fallback.data.length > 0) {
    return fallback.data;
  }

  // 3) Plano C: se por algum motivo áreas estiverem em categorias/geral
  const geral = await supabase
    .from("categorias")
    .select("chave,nome,ativo")
    .eq("contexto", "geral")
    .eq("ativo", true)
    .order("nome", { ascending: true });

  console.log("🧪 BUSCA categorias geral:", geral);

  if (!geral.error && Array.isArray(geral.data)) {
    return geral.data.filter((a) => a.chave !== "profissional");
  }

  return [];
}
function buildRaioList(phone) {
  return sendList(phone, "Até quantos km você aceita trabalhar?", [
    {
      title: "Raio",
      rows: [3, 5, 10, 20, 50].map((km) => ({
        id: `raio_${km}`,
        title: `${km} km`,
      })),
    },
  ]);
}

export async function handleOnboarding({
  user,
  text,
  phone,
  supabase,
  updateUser,

}) {

  if (user.etapa === "tipo") {
  if (!["tipo_usuario", "tipo_contratante", "tipo_empresa"].includes(text)) {
    return false;
  }

  let tipo = "usuario";
  if (text === "tipo_contratante") tipo = "contratante";
  if (text === "tipo_empresa") tipo = "empresa";

  await updateUser({
    tipo,
    etapa: "nome",
    onboarding_finalizado: false,
  });

  return sendText(phone, "Qual seu nome e sobrenome?");
}

  if (user.etapa === "nome") {
    if (!text || text.length < 3) {
      return sendText(phone, "Digite seu nome e sobrenome:");
    }

    await updateUser({
      nome: text,
      etapa: "cidade",
    });

    return sendText(
      phone,
      "Qual sua cidade?\n\nVocê pode escrever cidade + estado.\nExemplos:\n• Itabaiana - SE\n• Aracaju - SE\n• Maceió - AL"
    );
  }

  if (user.etapa === "cidade") {
    const { cidade, estado } = parseCidadeEstado(text);

    if (!cidade || cidade.length < 2) {
      return sendText(phone, "Digite uma cidade válida:");
    }

    if (estado) {
      await updateUser({
        cidade,
        estado,
        etapa: "email",
      });

      return sendText(phone, "Qual seu e-mail?");
    }

    await updateUser({
      cidade,
      etapa: "estado",
    });

    return sendList(phone, "Agora escolha o estado ou digite a sigla.\nEx: SE", [
      {
        title: "Estados",
        rows: estadosRows(),
      },
    ]);
  }

  if (user.etapa === "estado") {
    if (["voltar", "voltar_menu"].includes(text)) {
      await updateUser({
        etapa: "cidade",
        estado: null,
      });

      return sendText(
        phone,
        "Qual sua cidade?\n\nVocê pode escrever cidade + estado.\nExemplos:\n• Itabaiana - SE\n• Aracaju - SE\n• Maceió - AL"
      );
    }

    if (["menu", "inicio", "início"].includes(text)) {
      await updateUser({
        etapa: "tipo",
        onboarding_finalizado: false,
        cidade: null,
        estado: null,
      });

      return sendText(phone, "Escolha como deseja continuar pelo menu inicial.");
    }

    let estado = null;

    if (text.startsWith("estado_")) {
      estado = text.replace("estado_", "").toUpperCase();
    } else {
      estado = normalizeEstadoInput(text);
    }

    if (!estado) {
      return sendText(
        phone,
        "Escolha o estado pela lista ou digite a sigla.\nEx: SE"
      );
    }

    await updateUser({
      estado,
      etapa: "email",
    });

    return sendText(phone, "Qual seu e-mail?");
  }

  if (user.etapa === "email") {
  if (!isValidEmail(text)) {
    return sendText(phone, "Digite um e-mail válido.\nEx: nome@email.com");
  }

  if (user.tipo === "empresa") {
    await updateUser({
      email: text.trim().toLowerCase(),
      etapa: "cnpj",
    });

    return sendText(phone, "Digite o CNPJ da empresa:");
  }

  await updateUser({
    email: text.trim().toLowerCase(),
    etapa: "cpf",
  });

  return sendText(phone, "Digite seu CPF (apenas números):");
}
if (user.etapa === "cnpj") {
  const cnpjLimpo = cleanCNPJ(text);

  if (!isValidCNPJ(cnpjLimpo)) {
    return sendText(
      phone,
      "CNPJ inválido. Digite um CNPJ válido.\nEx: 12345678000195"
    );
  }

  await updateUser({
    cnpj: cnpjLimpo,
    etapa: "nome_empresa",
  });

  return sendText(phone, "Qual o nome da empresa?");
}
  if (user.etapa === "cpf") {
    const cpfLimpo = cleanCPF(text);

    if (!isValidCPF(cpfLimpo)) {
      return sendText(
        phone,
        "CPF inválido. Digite um CPF válido.\nEx: 12345678909"
      );
    }

    await updateUser({
      cpf: cpfLimpo,
    });

    

    if (user.tipo === "contratante") {
      await updateUser({
        etapa: "menu",
        onboarding_finalizado: true,
      });

      return sendMenuContratante(phone);
    }

    await updateUser({
      etapa: "area",
    });

    const areas = await getAreasAtivas(supabase);

    if (!areas.length) {
      return sendText(
        phone,
        "Não encontrei áreas cadastradas no momento. Tente novamente mais tarde."
      );
    }

   const previewAreas = areas
  .slice(0, 10)
  .map((a, index) => `${index + 1}. ${a.nome}`)
  .join("\n");

await sendText(
  phone,
  `Escolha sua área de interesse:\n\n${previewAreas}\n\n👇 Toque em "Ver opções" para selecionar.`
);

return sendList(phone, "Selecione uma área:", [
  {
    title: "Áreas",
    rows: areas.slice(0, 10).map((a) => ({
      id: `area_${a.chave}`,
      title: shortTitle(a.nome),
    })),
  },
]);
  }

  if (user.etapa === "nome_empresa") {
    if (!text || text.length < 2) {
      return sendText(phone, "Digite o nome da empresa:");
    }

    await updateUser({
      nome_empresa: text,
      etapa: "menu",
      onboarding_finalizado: true,
    });

    return sendMenuEmpresa(phone);
  }

if (user.etapa === "area") {
  if (!text.startsWith("area_")) return false;

  const area = text.replace("area_", "");

  await updateUser({
    area_principal: area,
    etapa: "categoria",
  });

  const { data, error } = await supabase
    .from("categorias")
    .select("chave,nome,ativo,area_chave,ordem")
    .eq("ativo", true)
    .eq("area_chave", area)
    .order("ordem", { ascending: true })
    .order("nome", { ascending: true });

  if (error) {
    console.log("❌ erro ao buscar categorias da área:", error.message);
  }

  const categorias = Array.isArray(data) ? data : [];

  if (!categorias.length) {
    await updateUser({ etapa: "area" });

    return sendText(
      phone,
      "Ainda não encontrei categorias para essa área. Escolha outra área ou envie 'menu' para recomeçar."
    );
  }

  const previewCategorias = categorias
  .slice(0, 10)
  .map((c, index) => `${index + 1}. ${c.nome}`)
  .join("\n");

await sendText(
  phone,
  `Escolha a categoria que mais combina com você:\n\n${previewCategorias}\n\n👇 Toque em "Ver opções" para selecionar.`
);

return sendList(phone, "Selecione uma categoria:", [
  {
    title: "Categorias",
    rows: categorias.slice(0, 10).map((c) => ({
      id: `cat_${c.chave}`,
      title: shortTitle(c.nome),
    })),
  },
]);
}

  if (user.etapa === "categoria") {
    if (!text.startsWith("cat_")) return false;

    const categoria = text.replace("cat_", "");

    await updateUser({
      categoria_principal: categoria,
      etapa: "subcategoria_1",
      subcategorias_temp: [],
    });

    const subcategorias = await getSubcategoriasByCategoria(
      supabase,
      categoria
    );

    if (!subcategorias.length) {
      await updateUser({ etapa: "raio" });
      return buildRaioList(phone);
    }

    return sendList(phone, "Escolha sua 1ª especialidade:", [
      {
        title: "Subcategorias",
        rows: subcategorias.slice(0, 10).map((s) => ({
          id: `subcat_${s.chave}`,
          title: s.nome,
        })),
      },
    ]);
  }

  if (user.etapa === "subcategoria_1") {
    if (!text.startsWith("subcat_")) return false;

    const sub = text.replace("subcat_", "");
    const atuais = [sub];

    await updateUser({
      subcategorias_temp: atuais,
      etapa: "subcategoria_2_confirm",
    });

    return sendActionButtons(phone, "Deseja adicionar outra especialidade?", [
      { id: "subcat_add_more", title: "Adicionar mais" },
      { id: "subcat_finish", title: "Concluir" },
    ]);
  }

  if (user.etapa === "subcategoria_2_confirm") {
    if (text === "subcat_finish") {
      const ok = await replaceUserSubcategorias(
        supabase,
        user.id,
        user.categoria_principal,
        user.subcategorias_temp || []
      );

      if (!ok) {
        return sendText(phone, "Erro ao salvar suas especialidades.");
      }

      await updateUser({ etapa: "raio" });
      return buildRaioList(phone);
    }

    if (text !== "subcat_add_more") return false;

    const subcategorias = await getSubcategoriasByCategoria(
      supabase,
      user.categoria_principal
    );

    const usadas = new Set(user.subcategorias_temp || []);
    const disponiveis = subcategorias.filter((s) => !usadas.has(s.chave));

    if (!disponiveis.length) {
      const ok = await replaceUserSubcategorias(
        supabase,
        user.id,
        user.categoria_principal,
        user.subcategorias_temp || []
      );

      if (!ok) {
        return sendText(phone, "Erro ao salvar suas especialidades.");
      }

      await updateUser({ etapa: "raio" });
      return buildRaioList(phone);
    }

    await updateUser({ etapa: "subcategoria_2" });

    return sendList(phone, "Escolha sua 2ª especialidade:", [
      {
        title: "Subcategorias",
        rows: disponiveis.slice(0, 10).map((s) => ({
          id: `subcat_${s.chave}`,
          title: s.nome,
        })),
      },
    ]);
  }

  if (user.etapa === "subcategoria_2") {
    if (!text.startsWith("subcat_")) return false;

    const sub = text.replace("subcat_", "");
    const atuais = Array.from(
      new Set([...(user.subcategorias_temp || []), sub])
    );

    await updateUser({
      subcategorias_temp: atuais,
      etapa: "subcategoria_3_confirm",
    });

    return sendActionButtons(phone, "Deseja adicionar mais uma especialidade?", [
      { id: "subcat_add_last", title: "Adicionar mais uma" },
      { id: "subcat_finish", title: "Concluir" },
    ]);
  }

  if (user.etapa === "subcategoria_3_confirm") {
    if (text === "subcat_finish") {
      const ok = await replaceUserSubcategorias(
        supabase,
        user.id,
        user.categoria_principal,
        user.subcategorias_temp || []
      );

      if (!ok) {
        return sendText(phone, "Erro ao salvar suas especialidades.");
      }

      await updateUser({ etapa: "raio" });
      return buildRaioList(phone);
    }

    if (text !== "subcat_add_last") return false;

    const subcategorias = await getSubcategoriasByCategoria(
      supabase,
      user.categoria_principal
    );

    const usadas = new Set(user.subcategorias_temp || []);
    const disponiveis = subcategorias.filter((s) => !usadas.has(s.chave));

    if (!disponiveis.length) {
      const ok = await replaceUserSubcategorias(
        supabase,
        user.id,
        user.categoria_principal,
        user.subcategorias_temp || []
      );

      if (!ok) {
        return sendText(phone, "Erro ao salvar suas especialidades.");
      }

      await updateUser({ etapa: "raio" });
      return buildRaioList(phone);
    }

    await updateUser({ etapa: "subcategoria_3" });

    return sendList(phone, "Escolha sua 3ª especialidade:", [
      {
        title: "Subcategorias",
        rows: disponiveis.slice(0, 10).map((s) => ({
          id: `subcat_${s.chave}`,
          title: s.nome,
        })),
      },
    ]);
  }

  if (user.etapa === "subcategoria_3") {
    if (!text.startsWith("subcat_")) return false;

    const sub = text.replace("subcat_", "");
    const atuais = Array.from(
      new Set([...(user.subcategorias_temp || []), sub])
    ).slice(0, 3);

    const ok = await replaceUserSubcategorias(
      supabase,
      user.id,
      user.categoria_principal,
      atuais
    );

    if (!ok) {
      return sendText(phone, "Erro ao salvar suas especialidades.");
    }

    await updateUser({
      subcategorias_temp: atuais,
      etapa: "raio",
    });

    return buildRaioList(phone);
  }

  if (user.etapa === "raio") {
    if (!text.startsWith("raio_")) return false;

    const raio = Number(text.replace("raio_", ""));

    if (!raio) {
      return sendText(phone, "Escolha o raio pela lista.");
    }

    await updateUser({
      raio_km: raio,
      etapa: "menu",
      onboarding_finalizado: true,
    });

    return sendMenuUsuario(phone);
  }

  return false;
}
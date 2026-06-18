// Fonction serverless Netlify — reçoit les données du formulaire quiz
// et les transmet à Brevo via l'API. La clé API Brevo n'est JAMAIS
// visible côté navigateur : elle est lue depuis une variable
// d'environnement Netlify, configurée dans Site settings.

exports.handler = async function (event) {
  // On n'accepte que les requêtes POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Méthode non autorisée" }),
    };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Corps de requête invalide" }),
    };
  }

  const { prenom, nom, email, tel, objectif, niveau, source, listId } = data;

  if (!prenom || !email) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Prénom et email sont obligatoires" }),
    };
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.error("BREVO_API_KEY non configurée dans les variables d'environnement Netlify");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Configuration serveur manquante" }),
    };
  }

  // Construction du payload Brevo
  const attributes = {
    FIRSTNAME: prenom,
  };
  if (nom) attributes.LASTNAME = nom;
  if (tel) {
    // Format attendu par Brevo : sans le 0 initial, avec indicatif pays
    // On suppose un numéro français par défaut (33), tout en gardant
    // le numéro brut si déjà au format international (+33...)
    let smsValue = tel.replace(/\s+/g, "");
    if (smsValue.startsWith("0")) {
      smsValue = "33" + smsValue.slice(1);
    } else if (smsValue.startsWith("+")) {
      smsValue = smsValue.slice(1);
    }
    attributes.SMS = smsValue;
  }
  if (objectif) attributes.OBJECTIF = objectif;
  if (niveau) attributes.NIVEAU_ENGAGEMENT = niveau;
  if (source) attributes.SOURCE = source;

  const payload = {
    email: email,
    attributes: attributes,
    updateEnabled: true, // si le contact existe déjà, on met à jour plutôt que planter
  };

  if (listId) {
    payload.listIds = [parseInt(listId, 10)];
  }

  try {
    let response = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "api-key": BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    // Brevo renvoie 201 (créé) ou 204 (mis à jour) en cas de succès
    if (response.status === 201 || response.status === 204) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true }),
      };
    }

    let errorBody = await response.text();

    // Si l'échec est spécifiquement lié à un doublon sur le numéro SMS,
    // on retente sans ce champ : mieux vaut capturer le lead avec son
    // email que de tout perdre pour un conflit de téléphone.
    let parsedError;
    try { parsedError = JSON.parse(errorBody); } catch(e) { parsedError = {}; }

    if (
      response.status === 400 &&
      parsedError.code === "duplicate_parameter" &&
      parsedError.metadata &&
      parsedError.metadata.duplicate_identifiers &&
      parsedError.metadata.duplicate_identifiers.includes("SMS")
    ) {
      console.warn("SMS en doublon détecté, nouvelle tentative sans le numéro de téléphone");
      const payloadWithoutSms = {
        ...payload,
        attributes: { ...payload.attributes },
      };
      delete payloadWithoutSms.attributes.SMS;

      response = await fetch("https://api.brevo.com/v3/contacts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "api-key": BREVO_API_KEY,
        },
        body: JSON.stringify(payloadWithoutSms),
      });

      if (response.status === 201 || response.status === 204) {
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, warning: "Contact créé sans le numéro de téléphone (déjà utilisé ailleurs)" }),
        };
      }

      errorBody = await response.text();
    }

    console.error("Erreur Brevo:", response.status, errorBody);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Erreur lors de l'envoi à Brevo", detail: errorBody }),
    };
  } catch (err) {
    console.error("Erreur réseau vers Brevo:", err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Impossible de contacter Brevo" }),
    };
  }
};

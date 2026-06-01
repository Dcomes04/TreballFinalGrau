# AgroSimulation

Aquest projecte és una plataforma web de suport a la decisió per simular el reg i la fertilització d’un cultiu. La plataforma permet crear superfícies de plantació, preparar simulacions, consultar resultats i generar un pla final de plantació.

El sistema treballa amb dades del cultiu, del sòl, del clima i de la ubicació. També utilitza fonts externes com Open-Meteo i OpenGeoHub per obtenir dades de suport. A partir d’aquestes dades, el motor de simulació calcula l’evolució del cultiu dia a dia.

La plataforma també inclou una arquitectura d’agents d’intel·ligència artificial. L’orquestrador interpreta la petició de l’usuari i tria quin agent o eina ha d’actuar. D’aquesta manera, el sistema pot separar millor les tasques de superfície, simulació i sòl.

La interfície web de la plataforma està organitzada en quatre parts principals:

* **Superfície**: permet calcular i guardar una distribució de plantes.
* **Simulació**: permet crear una nova simulació a partir del cultiu, la ubicació i les dades del sòl.
* **Simulació + Superfície**: permet unir una simulació correcta amb una superfície guardada.
* **Simulacions anteriors**: permet consultar, reutilitzar, descarregar o eliminar simulacions ja fetes.

Aquest repositori no conté tot el codi de la plataforma. Per motius de confidencialitat de l’empresa, només s’han publicat alguns fitxers representatius relacionats amb l’API, els serveis principals, les fórmules de simulació, els agents MCP i els tests associats a la carpeta `services`.

Els tests inclosos corresponen únicament a aquesta part perquè és on es concentra la lògica principal del backend: la creació i execució de simulacions, el càlcul de fórmules, la gestió d’escenaris, el context del sòl, les alarmes i la comunicació amb l’orquestrador. D’aquesta manera, es mostra la validació automàtica de les parts més rellevants del sistema sense publicar la totalitat del projecte ni altres mòduls interns no inclosos al repositori.

## Funcionament general

El funcionament bàsic és el següent:

1. L’usuari introdueix dades des de la interfície web.
2. La interfície envia una petició a l’API.
3. L’API valida les dades i crida el servei necessari.
4. Si cal suport dels agents, la petició passa a l’orquestrador.
5. L’orquestrador tria l’agent o la tool adequada.
6. El backend calcula o consulta la informació necessària.
7. El resultat es retorna a la interfície web.
8. L’usuari pot consultar els resultats amb gràfics i avisos.

## Fitxers inclosos en aquest repositori

En aquest repositori només apareix una part del projecte. Els fitxers publicats serveixen per mostrar l’estructura de l’API, els serveis de simulació, les fórmules i els agents MCP.

### Entrada de l’API

* `src/index.ts`: és l’entrada principal. Posa en marxa el servidor i, en Windows, intenta alliberar el port si està ocupat.
* `src/server.ts`: crea l’app d’Express, activa CORS, llegeix JSON i munta les rutes principals.

### Rutes HTTP

* `src/routes/catalogue.routes.ts`: agrupa les rutes de consulta del catàleg i la resolució de sòl i ubicació.
* `src/routes/executions.routes.ts`: agrupa les rutes de superfícies, execucions, resultats, CSV i plans de plantació.
* `src/routes/agent.routes.ts`: exposa la ruta que rep missatges d’agent i els passa a l’orquestrador.

### Serveis de suport

* `src/services/agent/index.ts`: fa de punt d’entrada del mòdul d’agents i reexporta els tipus i el servei principal.
* `src/services/agent/orchestrator.types.ts`: defineix l’estructura del missatge que entra i de la resposta que surt de l’orquestrador.
* `src/services/agent/orchestrator.service.ts`: envia la petició al servidor Python de l’orquestrador i adapta la resposta.
* `src/services/soil.service.ts`: resol el context del sòl a partir de coordenades o del nom d’una ubicació i reutilitza dades guardades quan pot.
* `src/services/scenario.service.ts`: calcula opcions de superfície per a una plantació i guarda un escenari temporal per recuperar-lo després.
* `src/services/alarms.service.ts`: crea alarmes quan la simulació entra en un cas fora de rang i marca l’execució com a fallida.

### Execucions

* `src/services/executions/executions.service.create.ts`: prepara una execució nova, crea les dades base del dia 0 i deixa a punt les fases FAO.
* `src/services/executions/executions.service.runtime.ts`: fa el càlcul de cada dia, actualitza sòl, clima, reg i fertilitzants, i guarda el resultat.
* `src/services/executions/executions.service.read.ts`: llegeix execucions, construeix la vista del resultat, treu el dataset CSV i elimina execucions.
* `src/services/executions/executions.service.plantacio-plan.ts`: genera i desa el pla d’una plantació a partir del resultat d’una execució.
* `src/services/executions/executions.service.climate.ts`: llegeix o desa el clima diari d’una execució.
* `src/services/executions/executions.service.crop-suitability.ts`: valora si les condicions d’un dia són bones, acceptables o dolentes per al cultiu.
* `src/services/executions/executions.service.utils.ts`: conté funcions petites per treballar amb dates, càlculs i lectura de clima.

### Fórmules

* `src/services/formulas/soil.formulas.ts`: conté les fórmules del sòl, l’aigua, la temperatura, els nutrients, el TDS, l’EC i el pH.
* `src/services/formulas/compo-phase.formulas.ts`: converteix dosis i freqüències de catàleg en valors útils per a la simulació.
* `src/services/formulas/fao-npk.formulas.ts`: reparteix el N, P i K de la fase FAO segons les proporcions definides per al cultiu.
* `src/services/formulas/events.formulas.ts`: construeix el pla diari de reg i fertirrigació.
* `src/services/formulas/charge-equivalents.formulas.ts`: calcula els equivalents de càrrega anió i catió dels fertilitzants.

### Integracions

* `src/integrations/openMeteo.client.ts`: parla amb Open-Meteo per obtenir clima diari i estadístiques tèrmiques anuals.
* `src/integrations/opengeohub.client.ts`: parla amb OpenGeoHub per obtenir textura i densitat del sòl a partir de coordenades.

### Agents Python

* `src/agents/common.py`: té funcions comunes per fer peticions HTTP des dels agents cap a l’API Node.
* `src/agents/orchestrator/orchestrator.py`: és l’orquestrador Python principal. Tria la tool correcta i coordina la resposta final.
* `src/agents/scenario/router.py`: defineix la tool del domini d’escenari.
* `src/agents/scenario/server.py`: arrenca el servidor MCP de l’escenari.
* `src/agents/simulation/router.py`: defineix les tools del domini de simulació i del pla de plantació.
* `src/agents/simulation/server.py`: arrenca el servidor MCP de simulació.
* `src/agents/soil/router.py`: defineix la tool per resoldre el context del sòl.
* `src/agents/soil/server.py`: arrenca el servidor MCP del sòl.

### Tests

* `src/services/tests/agent/TestAgentIndex.test.ts`: comprova el punt d’entrada del mòdul d’agents i valida que les exportacions principals estiguin disponibles correctament.
* `src/services/tests/agent/TestOrchestratorService.test.ts`: comprova el servei de l’orquestrador, incloent l’enviament de peticions al servidor Python i l’adaptació de la resposta.
* `src/services/tests/agent/TestOrchestratorTypes.test.ts`: valida els esquemes i tipus utilitzats en les peticions i respostes de l’orquestrador.

* `src/services/tests/executions/TestExecutionsServiceClimate.test.ts`: comprova la lectura, generació i persistència de dades climàtiques associades a una execució.
* `src/services/tests/executions/TestExecutionsServiceCreate.test.ts`: comprova la creació d’una execució nova, la preparació de les dades inicials i la inicialització de la simulació.
* `src/services/tests/executions/TestExecutionsServiceCropSuitability.test.ts`: comprova si les condicions climàtiques i del sòl són adequades per al cultiu.
* `src/services/tests/executions/TestExecutionsServicePlantacioPlan.test.ts`: comprova la generació i el desat del pla de plantació a partir dels resultats d’una execució.
* `src/services/tests/executions/TestExecutionsServiceRead.test.ts`: comprova la lectura d’execucions, resultats, dades associades i operacions de consulta.
* `src/services/tests/executions/TestExecutionsServiceRuntime.test.ts`: comprova l’execució diària de la simulació, incloent el càlcul de reg, sòl, clima i fertilització.
* `src/services/tests/executions/TestExecutionsServiceUtils.test.ts`: comprova funcions auxiliars utilitzades per les execucions, com el tractament de dates, càlculs i lectura de dades.

* `src/services/tests/formulas/TestChargeEquivalentsFormulas.test.ts`: comprova les fórmules relacionades amb els equivalents de càrrega d'anions i cations dels fertilitzants.
* `src/services/tests/formulas/TestCompoPhaseFormulas.test.ts`: comprova la conversió de dosis, freqüències i valors de catàleg COMPO en dades utilitzables per la simulació.
* `src/services/tests/formulas/TestEventsFormulas.test.ts`: comprova la generació d’esdeveniments diaris de reg i fertirrigació.
* `src/services/tests/formulas/TestFaoNpkFormulas.test.ts`: comprova el repartiment de N, P i K segons les necessitats de la fase FAO i les proporcions definides.
* `src/services/tests/formulas/TestSoilFormulas.test.ts`: comprova les fórmules del sòl, el balanç hídric, la temperatura, els nutrients, el TDS, l’EC i el pH.

* `src/services/tests/ml/TestCatboostFaoService.test.ts`: comprova el servei encarregat de preparar dades i interactuar amb el model CatBoost relacionat amb paràmetres FAO.
* `src/services/tests/ml/TestSoilTextureService.test.ts`: comprova el servei de classificació de textura del sòl.

* `src/services/tests/TestAlarmsService.test.ts`: comprova la creació d’alarmes quan es detecten valors fora de rang o errors durant la simulació.
* `src/services/tests/TestScenarioService.test.ts`: comprova el càlcul d’opcions de superfície, la generació d’escenaris i la seva recuperació posterior.
* `src/services/tests/TestSoilService.test.ts`: comprova la resolució del context del sòl a partir de coordenades o ubicació i la classificació de la textura del sòl.

## Com es reparteix la feina

L’API rep les peticions de la interfície web o dels agents. Després passa la feina als serveis del backend.

Els serveis s’encarreguen de preparar dades, fer càlculs, consultar informació i guardar resultats. Les fórmules es troben separades en fitxers propis per tenir el codi més ordenat.

Els agents Python serveixen per rebre una petició, entendre quina acció es vol fer i portar-la cap a la ruta o servei corresponent.

## Parts no incloses en aquest repositori

Per motius de confidencialitat, aquest repositori no inclou tot el codi del projecte complet. Algunes parts no s’han publicat perquè formen part de l’entorn intern de l’empresa o perquè contenen informació que no es pot compartir.

No s’inclouen completament:

* La interfície web completa.
* La base de dades completa.
* Fitxers interns de configuració.
* Fitxers amb dades internes.
* Fitxers amb informació sensible.
* Algunes parts del projecte que depenen de l’entorn de l’empresa.
* Secrets, claus, credencials o variables d’entorn.

Els fitxers publicats tenen l’objectiu de mostrar l’estructura general de la part tècnica que es pot compartir, sense exposar informació privada.

## Confidencialitat

Aquest projecte s’ha desenvolupat dins d’un entorn d’empresa. Per aquest motiu, no es pot publicar tot el codi font ni tots els fitxers utilitzats durant el desenvolupament.

El repositori mostra només una part del sistema, suficient per entendre la feina feta en l’API, el motor de simulació, les fórmules i els agents. La resta del projecte queda fora del repositori per protegir informació interna de l’empresa.

Aquesta limitació no canvia l’objectiu del Treball Final de Grau. El projecte complet inclou una plataforma web, una API, una base de dades, un motor de simulació, fonts externes de dades i un sistema multi-agent amb orquestrador d’intel·ligència artificial.

## Limitacions del sistema

Els resultats de la simulació són aproximacions. El sistema utilitza dades, fórmules i regles definides dins del projecte, però no substitueix el criteri d’un professional agrícola.

La plataforma està pensada com una eina de suport a la decisió. Serveix per estudiar possibles situacions abans de plantar, veure l’evolució del cultiu i comparar resultats simulats.

## Nota final

Aquest README descriu el projecte complet a nivell general, però els fitxers del repositori només representen la part que es pot publicar. La resta del codi no s’inclou per confidencialitat.

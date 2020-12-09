var Fhir = require('fhir').Fhir;
var ParseConformance = require('fhir').ParseConformance;
var FhirVersions = require('fhir').Versions;
var fs = require('fs');
var xml2js = require('xml2js');
const yargs = require('yargs');

// Parse command line options and argumens
const argv = yargs
    .option('max-file', {
        alias: 'm',
        description: 'Path to .max file',
        type: 'string',
        demandOption: true
    })
    .option('zib-release', {
        alias: 'z',
        description: 'The zib release to check mappings for',
        type: 'string',
        choices: ['2017', '2020'],
        demandOption: true
    })
    .option('fhir-version', {
        alias: 'v',
        description: 'The FHIR version to use (the "fhirVersion" element in the structuredefinitions will be ignored).\nIf the version is STU3, the definitions should be present in the "definitions" folder.',
        type: 'string',
        choices: ['STU3', 'R4'],
        default: 'R4'
    })
    .option('restrict-missing', {
        alias: 'r',
        description: 'Restrict the check for missing arguments to the zibs that have been mapped to the provided profiles',
        type: 'boolean',
    })
    .option('allow-level', {
        alias: 'l',
        description: 'A number from 0-2 to indicate at which level errors are still allowed (0=error, 1=warning, 2=allow all). If errors below the specified level occur, this script will exit with a non-zero status.',
        type: 'number',
        default: 1
    }).option('output-format', {
        alias: 'f',
        description: 'Set the output format to either text or XML.\nIn both cases, the output will be printed to stdout.\nWhen the output us XML, a complete record of all found elements is created, while additional problems are printed to stderr.\nWhen the output format is text, only the issues found are printed.',
        default: 'xml',
        type: 'string',
        choices: ['xml', 'text']
    })
    .command("$0 [options] <files..>", "")
    .help().alias('help', 'h')
    .argv;

// Instantiate the FHIR parser
if (argv["fhir-version"] == "STU3") {
    // Fhir versions other than R4 need to manually load the definitions
    var newValueSets = JSON.parse(fs.readFileSync('definitions/valuesets.json').toString());
    var newTypes = JSON.parse(fs.readFileSync('definitions/profiles-types.json').toString());
    var newResources = JSON.parse(fs.readFileSync('definitions/profiles-resources.json').toString());
    var parser = new ParseConformance(false, FhirVersions.STU3);
    parser.parseBundle(newValueSets);
    parser.parseBundle(newTypes);
    parser.parseBundle(newResources);
    var fhir = new Fhir(parser);
} else {
    var fhir = new Fhir();
}

// read and parse zibs from max xml source to json
var xmlParser = new xml2js.Parser();
var max = fs.readFileSync(argv["max-file"]);
var zibs = {};
xmlParser.parseString(max, function (err, result) {
    zibs = result;
});

// relationship with sourceId = id, targetId = datatypeid, type=Generalization
var datatypes = {
    7887: "TS",
    7906: "CD",
    7895: "ST",
    7891: "PQ",
    7892: "BL",
    7888: "INT",
    7886: "CO",
    7885: "ED",
    7889: "II",
    7903: "ANY" };

// create zib concept indexes
// only add objects that have a DCM::ConceptId
var _packageByConceptId = []; // package id by conceptid
var _conceptsById = []; // object by conceptid
zibs.model.objects[0].object.forEach(object => {
    if (object.parentId && object.tag) {
        var tag = object.tag.find(tag => tag.$.name === 'DCM::ConceptId');
        if (!tag) {
            // this is possibly an "old" zib with conceptid in definitioncode
            tag = object.tag.find(tag => tag.$.name === 'DCM::DefinitionCode' && tag.$.value.startsWith("NL-CM:"));
        }
        if (tag) {
            var zibId = tag.$.value;
            _packageByConceptId[zibId] = object.parentId;
            _conceptsById[zibId] = object;

            // relationship type = Generalization ; sourceId = zibId map destId
            var relDt = zibs.model.relationships[0].relationship.find(relationship => relationship.type[0] === "Generalization" && relationship.sourceId[0] == object.id);
            if (relDt) {
                object.datatype = datatypes[relDt.destId];
            }

            // relationship typ = Aggregation ; sourfeId = zibId sourceCard
            var relCard = zibs.model.relationships[0].relationship.find(relationship => relationship.type[0] === "Aggregation" && relationship.sourceId[0] == object.id);
            if (!relCard || relCard.sourceCard == '') {
                // when no cardinality specified default
                object.cardinality = "0..1";
            }
            else if (relCard) {
                var card = relCard.sourceCard;
                if (card == "1") card = "1..1";
                object.cardinality = card;
            }
        }
    }
});

var _zibIdsMapped = [];

// Collect all NL-CM:xx.xx prefixes that are present in the supplied structuredefinitions
var cmPrefixes = new Set();

// Collect the lowest warning level along the way (0 = error, 1 = warning, 2 = none)
var lowestWarnLevel = 2;

// The identifier to recognize mappings for the target zib release
let zibRegEx = new RegExp("-" + argv["zib-release"] + "EN");

report("<report>");
argv.files.forEach(filename => {
    var json = fs.readFileSync(filename);

    // zib compliance check only for StructureDefinitions
    var resource = JSON.parse(json);
    var validated = false;
    if (resource.resourceType == "StructureDefinition") {
        if (resource.mapping) {
            report(`<structuredefinition name="${filename}">`, '==== ' + filename);

            // does this resource have mappings to the target zib release?
            let hasZibReleaseMappings = resource.mapping.find(mapping => zibRegEx.test(mapping.identity));
            if (hasZibReleaseMappings) {
                if (!validated) {
                    // validate fhir structuredef only if there are any zib mappings
                    var result = fhir.validate(resource);
                    if (result.messages.length > 0) {
                        // Sometimes the validator complains that the FHIR version is unknown. if that's the case, we
                        // remove the offending message first.
                        if (result.messages[0].location == "StructureDefinition.fhirVersion" &&
                            result.messages[0].message.match(/Code \"[0-9\.]+\" not found in value set/)) {
                                result.messages = result.messages.slice(1);
                        }
                    }
                    if (result.messages.length > 0) {
                        if (result.valid) {
                            var level = 1;
                            var type  = "WARN"
                        } else {
                            var level = 0;
                            var type  = "ERROR"
                        }
                        reportError(`${type}: validating resource ${filename}\n` + JSON.stringify(result.messages, null, 4), level);
                    }
                }
                validated = true;

                // check elements in snapshot for mappings
                if (resource.snapshot) {
                    resource.snapshot.element.forEach(element => {
                        if (element.mapping) {
                            // check mappings and only handle mappings to the target zib release
                            element.mapping.forEach(mapping => {
                                if (zibRegEx.test(mapping.identity)) {
                                    cmPrefixes.add(getCMPrefix(mapping.map))

                                    var reportLine = { fhir_filename: filename, fhir_id: resource.id };
                                    var zibConceptId = mapping.map;
                                    if (_zibIdsMapped.indexOf(zibConceptId) == -1) _zibIdsMapped.push(zibConceptId);
                                    var concept = _conceptsById[zibConceptId];
                                    if (!concept) {
                                        reportError(`ERROR: unknown concept ${zibConceptId}`);
                                        return;
                                    }

                                    var element_short = element.short.toString();
                                    var aliasEn = concept.alias[0].substring(3).trim();
                                    var element_alias = element.alias?element.alias.toString():'';
                                    var object_name = concept.name.toString();

                                    reportLine.zib_concept_id = zibConceptId;
                                    reportLine.fhir_path = element.path;
                                    reportLine.zib_alias_en = aliasEn;
                                    reportLine.fhir_short = element_short;
                                    reportLine.fhir_short_warn = (aliasEn != element_short)?"WARN":"OK";
                                    reportLine.zib_name = object_name;
                                    reportLine.fhir_alias = element_alias;
                                    reportLine.fhir_alias_warn = (element_alias.indexOf(object_name) == -1)?"WARN":"OK";

                                    if (concept.datatype) {
                                        var fhirdt = (element.type?element.type[0].code:undefined);
                                        var compatible;
                                        if (concept.datatype == 'II' && fhirdt == "Identifier") compatible = "OK";
                                        else if (concept.datatype == 'ST' && fhirdt == "string") compatible = "OK";
                                        else if (concept.datatype == 'ST' && fhirdt == "Annotation") compatible = "OK";
                                        else if (concept.datatype == 'PQ' && fhirdt == "Duration") compatible = "OK";
                                        else if (concept.datatype == 'PQ' && fhirdt == "Quantity") compatible = "OK";
                                        else if (concept.datatype == 'PQ' && fhirdt == "integer") compatible = "WARN"; // what is the unit?
                                        else if (concept.datatype == 'PQ' && fhirdt == "decimal") compatible = "WARN"; // what is the unit?
                                        else if (concept.datatype == 'CD' && fhirdt == "CodeableConcept") compatible = "OK";
                                        else if (concept.datatype == 'CD' && fhirdt == "code") compatible = "OK";
                                        else if (concept.datatype == 'CD' && fhirdt == "Coding") compatible = "OK";
                                        else if (concept.datatype == 'CD' && fhirdt == "string") compatible = "WARN"; // what is the codesystem
                                        else if (concept.datatype == 'CO' && fhirdt == "Coding") compatible = "OK";
                                        else if (concept.datatype == 'TS' && fhirdt == "dateTime") compatible = "OK";
                                        else if (concept.datatype == 'TS' && fhirdt == "date") compatible = "OK";
                                        else if (concept.datatype == 'TS' && fhirdt == "Period") compatible = "ERROR start|end";
                                        else if (concept.datatype == 'BL' && fhirdt == "boolean") compatible = "OK";
                                        else if (concept.datatype == 'INT' && fhirdt == "integer") compatible = "OK";
                                        else if (concept.datatype == 'INT' && fhirdt == "Quantity") compatible = "WARN"; // what is the unit?
                                        else if (concept.datatype == 'ED' && fhirdt == "base64Binary") compatible = "OK";
                                        else if (concept.datatype == 'ED' && fhirdt == "Attachement") compatible = "OK";
                                        else if (fhirdt == "Extension") compatible = "CHECK extension.value[x]";
                                        else compatible = "ERROR";
                                        reportLine.zib_datatype = concept.datatype;
                                        reportLine.fhir_datatype = fhirdt;
                                        reportLine.fhir_datatype_error = compatible;
                                    }
                                    else {
                                        var tag1 = concept.tag.find(tag => tag.$.name === 'DCM::ReferencedConceptId');
                                        var tag2 = concept.tag.find(tag => tag.$.name === 'DCM::ReferencedDefinitionCode');
                                        var fhirdt = (element.type?element.type[0].code:undefined);
                                        reportLine.fhir_datatype = fhirdt;
                                        if (tag1 || tag2) {
                                            reportLine.zib_datatype = "reference";
                                            reportLine.fhir_datatype_error = (fhirdt != "Reference")?"WARN":"OK";
                                        }
                                        else {
                                            reportLine.zib_datatype = concept.stereotype;
                                            var fhir_datatype_error;
                                            if (fhirdt == "Extension") reportLine.fhir_datatype_error = "CHECK Extension";
                                            else if (reportLine.zib_datatype == 'container' && fhirdt == "Reference") fhir_datatype_error = "OK";
                                            else if (reportLine.zib_datatype == 'container' && fhirdt == undefined) fhir_datatype_error = "OK";
                                            else if (reportLine.zib_datatype == 'rootconcept' && fhirdt == undefined) fhir_datatype_error = "OK";
                                            else if (reportLine.zib_datatype == 'rootconcept' && fhirdt != undefined) fhir_datatype_error = "WARN";
                                            else fhir_datatype_error = "ERROR";
                                            reportLine.fhir_datatype_error = fhir_datatype_error;
                                        }
                                    }
                                    if (concept.cardinality) {
                                        var card = element.min + ".." + element.max;
                                        reportLine.zib_card = concept.cardinality;
                                        reportLine.fhir_card = card;
                                        reportLine.fhir_card_warn = (card != concept.cardinality)?"WARN":"OK";
                                        // if fhir has strickter cardinality then error
                                        if ((concept.cardinality == '0..*' || concept.cardinality == '1..*') && element.max == '1') reportLine.fhir_card_warn = "ERROR";
                                    }
                                    report(reportLineToXml, reportLineToText, reportLine);
                                    lowestWarnLevel = Math.min(lowestWarnLevel, getWarnLevel(reportLine));
                                }
                            });
                        }
                    });
                }
                else {
                    reportError("ERROR: no snapshot for " + filename);
                }
            }
            report("</structuredefinition>");
        }
    }
});
report("</report>");

// show not mapped zibIds
Object.keys(_conceptsById).forEach(zibId => {
    if (_zibIdsMapped.indexOf(zibId) == -1) {
        // ignore containers and rootconcepts
        if (_conceptsById[zibId].stereotype != "container" && _conceptsById[zibId].stereotype != "rootconcept") {
            
            let cmPrefix = getCMPrefix(zibId)
            if (!argv.r || cmPrefixes.has(cmPrefix)) { // If the -r flag is set, only report from zibs that are in the supplied profiles
                var parentId = _conceptsById[zibId].parentId;
                let msg = ""

                // find rootconcept with this concept
                var rootconcept = zibs.model.objects[0].object.find(obj => obj.stereotype == "rootconcept" && obj.parentId[0] == parentId[0]);
                if (rootconcept) {
                    msg = "  WARN: not mapped " + rootconcept.name + "." + _conceptsById[zibId].name + " " + zibId;
                }
                else {
                    msg = "  WARN: not mapped ???." + _conceptsById[zibId].name + " " + zibId;
                }
                if (argv["output-format"] == "xml") {
                    console.warn(msg);
                } else {
                    report(null, msg);
                }

                lowestWarnLevel = Math.min(lowestWarnLevel, 1);
            }
        }
    }
});
reportError("zibConceptIds: " + Object.keys(_conceptsById).length + " mapped: " + _zibIdsMapped.length, 2);

// Return with a succes or failure status code
if (lowestWarnLevel < argv["allow-level"]) {
    reportError("\nThere were errors below your threshold. The test has FAILED.");
    process.exit(1);
}

function reportLineToXml(report) {
    var line = "<line>";
    line += "<zib_concept_id>" + report.zib_concept_id + "</zib_concept_id>";
    line += "<fhir_path>" + report.fhir_path + "</fhir_path>";
    line += "<zib_alias_en>" + report.zib_alias_en + "</zib_alias_en>";
    line += "<fhir_short>" + report.fhir_short + "</fhir_short>";
    line += "<fhir_short_warn>" + report.fhir_short_warn + "</fhir_short_warn>";
    line += "<zib_name>" + report.zib_name + "</zib_name>";
    line += "<fhir_alias>" + report.fhir_alias + "</fhir_alias>";
    line += "<fhir_alias_warn>" + report.fhir_alias_warn + "</fhir_alias_warn>";
    line += "<zib_datatype>" + report.zib_datatype + "</zib_datatype>";
    line += "<fhir_datatype>" + report.fhir_datatype + "</fhir_datatype>";
    line += "<fhir_datatype_error>" + report.fhir_datatype_error + "</fhir_datatype_error>";
    line += "<zib_card>" + report.zib_card + "</zib_card>";
    line += "<fhir_card>" + report.fhir_card + "</fhir_card>";
    line += "<fhir_card_warn>" + report.fhir_card_warn + "</fhir_card_warn>";
    line += "<fhir_filename>" + report.fhir_filename + "</fhir_filename>";
    line += "<fhir_id>" + report.fhir_id + "</fhir_id>";
    line += "</line>";
    return(line);
}

function reportLineToText(report) {
    let lines = []
    if (report.fhir_short_warn != 'OK') {
        lines.push(`        short:       ${report.fhir_short_warn} (${report.zib_alias_en}/${report.fhir_short})`)
    }
    if (report.fhir_alias_warn != 'OK') {
        lines.push(`        alias:       ${report.fhir_alias_warn} (${report.zib_name}/${report.fhir_alias})`)
    }
    if (report.fhir_datatype_error != 'OK') {
        lines.push(`        datatype:    ${report.fhir_datatype_error} (${report.zib_datatype}/${report.fhir_datatype})`)
    }
    if (report.fhir_card_warn != 'OK') {
        lines.push(`        cardinality: ${report.fhir_card_warn} (${report.zib_card}/${report.fhir_card})`)
    }
    if (lines.length > 0) {
        lines = [`     == ${report.zib_concept_id} (${report.fhir_path})`].concat(lines)
        return lines.join('\n');
    }
    return null
}

/**
 * Report some xml or textual output, depending on the output format set by the user.
 * @param {string|function|null} xml - a formatted XML string, or a function which returns a formatted string, to 
 *                                     output when the output format is "xml".
 * @param {string|function|null} text - a text string, or a function which returns a text string, to output when the
 *                                      output format is "text".
 * @param {any} args - the arguments to passed to the xml or text function.
 */
function report(xml = null, text = null, ...args) {
    let output = null
    if (argv["output-format"] == "xml" && xml != null) {
        output = xml
    } else if (argv["output-format"] == "text" && text != null) {
        output = text;
    }
    if (typeof output == 'function') {
        output = output.apply(this, args);
    }
    if (output) {
        console.log(output);
    }
}

/**
 * Report an error of some sort. When the output format is XML, it will be sent to stdout so it won't affect the XML
 * output. When the output format is text, the message will be sent to stdout.
 * @param {string} message 
 * @param {int} [level=0] - The gravity of this error. This will be used to update lowestWarnLevel if needed.
 */
function reportError(message, level = 0) {
    if (argv["output-format"] == "xml") {
        console.error(message);
    } else {
        console.log(message);
    }
    lowestWarnLevel = Math.min(lowestWarnLevel, level);
}
/**
 * Get the lowest error level from the constructed reportLine
 * @param {Object} reportLine 
 */
function getWarnLevel(reportLine) {
    return ["fhir_short_warn", "fhir_alias_warn", "fhir_datatype_error", "fhir_card_warn"].map(el => {
        if (reportLine[el]) {
            if (reportLine[el].startsWith("OK")) {
                return 2;
            } else if (reportLine[el].startsWith("WARN")) {
                return 1;
            } else if (reportLine[el].startsWith("ERROR")) {
                return 0;
            }
        }
        return 2;
    }).reduce((result, curr) => {
        return Math.min(result, curr)
    })
}

/**
 * Extract the "CM-NL:xx.xx" prefix from a concept id string
 * @param {string} cmString - a full zib concept id string
 */
function getCMPrefix(cmString) {
    return cmString.replace(/(NL-CM:[0-9]+\.[0-9]+)\..+/, "$1");
}
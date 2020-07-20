var Fhir = require('fhir').Fhir;
var ParseConformance = require('fhir').ParseConformance;
var FhirVersions = require('fhir').Versions;
var fs = require('fs');
var xml2js = require('xml2js');
const { report } = require('process');

// // Get the data
var newValueSets = JSON.parse(fs.readFileSync('definitions/valuesets.json').toString());
var newTypes = JSON.parse(fs.readFileSync('definitions/profiles-types.json').toString());
var newResources = JSON.parse(fs.readFileSync('definitions/profiles-resources.json').toString());

// // Create a parser and parse it using the parser
var parser = new ParseConformance(false, FhirVersions.STU3);           // don't load pre-parsed data
parser.parseBundle(newValueSets);
parser.parseBundle(newTypes);
parser.parseBundle(newResources);
var fhir = new Fhir(parser);

// read and parse zibs from max xml source to json
var xmlParser = new xml2js.Parser();
var max = fs.readFileSync('definitions/ZIBS Publicatieversie 2017.max');
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

// find structure definitions filenames with mappings to "-2017EN"
console.log("<report>");
fs.readdirSync("package").forEach(filename => {
    var json = fs.readFileSync("package/" + filename);

    // zib compliance check only for StructureDefinitions
    var resource = JSON.parse(json);
    var validated = false;
    if (resource.resourceType == "StructureDefinition") {
        if (resource.mapping) {
            // does this resource have zib 2017 mappings?
            var has2017Mappings = resource.mapping.find(mapping => /-2017EN/.test(mapping.identity));
            if (has2017Mappings) {
                if (!validated) {
                    // validate fhir structuredef only if there are any zib mappings
                    var result = fhir.validate(resource);
                    // for some reason fhirVersion = 3.0.2 is always the first error message; ignore
                    result.messages = result.messages.slice(1);
                    if (result.messages.length > 0) {
                        console.error(filename);
                        console.error(result);
                    }
                }
                validated = true;

                // check elements in snapshot for mappings
                if (resource.snapshot) {
                    resource.snapshot.element.forEach(element => {
                        if (element.mapping) {
                            // check mappings and only handle 2017EN mappings
                            element.mapping.forEach(mapping => {
                                if (/-2017EN/.test(mapping.identity)) {
                                    var reportLine = { fhir_filename: filename, fhir_id: resource.id };
                                    var zibConceptId = mapping.map;
                                    if (_zibIdsMapped.indexOf(zibConceptId) == -1) _zibIdsMapped.push(zibConceptId);
                                    var concept = _conceptsById[zibConceptId];

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
                                    reportLineToXml(reportLine);
                                }
                            });
                        }
                    });
                }
                else {
                    console.error("  ERROR: has no snapshot?? " + filename);
                }
            }
        }
    }
});
console.log("</report>");

// show not mapped zibIds
Object.keys(_conceptsById).forEach(zibId => {
    if (_zibIdsMapped.indexOf(zibId) == -1) {
        // ignore containers and rootconcepts
        if (_conceptsById[zibId].stereotype != "container" && _conceptsById[zibId].stereotype != "rootconcept") {
            var parentId = _conceptsById[zibId].parentId;
            // find rootconcept with this concept
            var rootconcept = zibs.model.objects[0].object.find(obj => obj.stereotype == "rootconcept" && obj.parentId[0] == parentId[0]);
            if (rootconcept) {
                console.error("  WARN: not mapped " + rootconcept.name + "." + _conceptsById[zibId].name + " " + zibId);
            }
            else {
                console.error("  WARN: not mapped ???." + _conceptsById[zibId].name + " " + zibId);
            }
        }
    }
});
console.error("zibConceptIds: " + Object.keys(_conceptsById).length + " mapped: " + _zibIdsMapped.length);

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
    console.log(line);
}

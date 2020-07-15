var Fhir = require('fhir').Fhir;
var ParseConformance = require('fhir').ParseConformance;
var FhirVersions = require('fhir').Versions;
var fs = require('fs');
var xml2js = require('xml2js');

// // Get the data
var newValueSets = JSON.parse(fs.readFileSync('definitions/valuesets.json').toString());
var newTypes = JSON.parse(fs.readFileSync('definitions/profiles-types.json').toString());
var newResources = JSON.parse(fs.readFileSync('definitions/profiles-resources.json').toString());

// // Create a parser and parse it using the parser
var parser = new ParseConformance(false, FhirVersions.STU3);           // don't load pre-parsed data
parser.parseBundle(newValueSets);
parser.parseBundle(newTypes);
parser.parseBundle(newResources);
var fhir = new Fhir();

// read and parse zibs from max xml source to json
var xmlParser = new xml2js.Parser();
var max = fs.readFileSync('definitions/ZIBS Publicatieversie 2017.max');
var zibs = {};
xmlParser.parseString(max, function (err, result) {
    zibs = result;
});

// relationship with sourceId = id, targetId = datatypeid, type=Generalization
/*
	<datatype id="7887" name="TS" fhir="dateTime"/>
    <datatype id="7906" name="CD" fhir="Coding"/>
    <datatype id="7895" name="ST" fhir="string"/>
    <datatype id="7891" name="PQ" fhir="Quantity"/>
    <datatype id="7892" name="BL" fhir="boolean"/>
    <datatype id="7888" name="INT" fhir="integer"/>
    <datatype id="7886" name="CO" fhir="Coding"/>
    <datatype id="7885" name="ED" fhir="base64Binary"/>
    <datatype id="7889" name="II" fhir="Identifier"/>
    <datatype id="7903" name="ANY" fhir="Element"/>		
*/
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
fs.readdirSync("package").forEach(filename => {
    var json = fs.readFileSync("package/" + filename);

    // zib compliance check only for StructureDefinitions
    var resource = JSON.parse(json);
    var hasZibMappings = false;
    if (resource.resourceType == "StructureDefinition") {
        if (resource.mapping) {
            resource.mapping.forEach(mapping => {
                if (/-2017EN/.test(mapping.identity)) {
                    if (!hasZibMappings) {
                        console.log(filename);
                        // validate fhir structuredef only if there are any zib mappings
                        var result = fhir.validate(resource);
                        // for some reason fhirVersion = 3.0.2 is always the first error message; ignore
                        result.messages = result.messages.slice(1);
                        if (result.messages.length > 0) {
                            console.log(result);
                        }
                    }
                    hasZibMappings = true;

                    // check elements in snapshot for mappings
                    if (resource.snapshot) {
                        resource.snapshot.element.forEach(element => {
                            if (element.mapping) {
                                // check mappings and only handle 2017EN mappings
                                element.mapping.forEach(mapping => {
                                    if (/-2017EN/.test(mapping.identity)) {
                                        var zibId = mapping.map;
                                        if (_zibIdsMapped.indexOf(zibId) == -1) _zibIdsMapped.push(zibId);
                                        var concept = _conceptsById[zibId];

                                        var element_short = element.short.toString();
                                        var nameEn = concept.alias[0].substring(3).trim();
                                        var element_alias = element.alias?element.alias.toString():'';
                                        var object_name = concept.name.toString();

                                        console.log("  " + element.path + " -> " + zibId);
                                        if (nameEn != element_short) {
                                            console.log("    WARN short: " + element.short + " -> " + nameEn);
                                        }
                                        if (element_alias.indexOf(object_name) == -1) {
                                            console.log("    WARN alias: " + element.alias + " -> " + concept.name);
                                        }
                                        if (concept.datatype) {
                                            var fhirdt = (element.type?element.type[0].code:'');
                                            var compatible = false;
                                            if (concept.datatype == 'II' && fhirdt == "Identifier") compatible = true;
                                            else if (concept.datatype == 'ST' && fhirdt == "string") compatible = true;
                                            else if (concept.datatype == 'ST' && fhirdt == "Annotation") compatible = true;
                                            else if (concept.datatype == 'PQ' && fhirdt == "Duration") compatible = true;
                                            else if (concept.datatype == 'PQ' && fhirdt == "Quantity") compatible = true;
                                            else if (concept.datatype == 'CD' && fhirdt == "CodeableConcept") compatible = true;
                                            else if (concept.datatype == 'CD' && fhirdt == "code") compatible = true;
                                            else if (concept.datatype == 'CD' && fhirdt == "Coding") compatible = true;
                                            else if (concept.datatype == 'TS' && fhirdt == "dateTime") compatible = true;
                                            else if (concept.datatype == 'TS' && fhirdt == "date") compatible = true;
                                            else if (concept.datatype == 'BL' && fhirdt == "boolean") compatible = true;
                                            if (!compatible) {
                                                console.log("    ERROR type: " + fhirdt + " -> " + concept.datatype);
                                            }
                                        }
                                        if (concept.cardinality) {
                                            var card = element.min + ".." + element.max;
                                            if (card != concept.cardinality) {
                                                console.log("    WARN card: " + card + "-> " + concept.cardinality);
                                            }
                                        }
                                    }
                                });
                            }
                        });
                    }
                    else {
                        console.log("  ERROR: has no snapshot?? " + filename);
                    }
                }
            });
        }
    }
});

// show not mapped zibIds
Object.keys(_conceptsById).forEach(zibId => {
    if (_zibIdsMapped.indexOf(zibId) == -1) {
        // ignore containers and rootconcepts
        if (_conceptsById[zibId].stereotype != "container" && _conceptsById[zibId].stereotype != "rootconcept") {
            var parentId = _conceptsById[zibId].parentId;
            // find rootconcept with this concept
            var rootconcept = zibs.model.objects[0].object.find(obj => obj.stereotype == "rootconcept" && obj.parentId[0] == parentId[0]);
            if (rootconcept) {
                console.log("  WARN: not mapped " + rootconcept.name + "." + _conceptsById[zibId].name + " " + zibId);
            }
            else {
                console.log("  WARN: not mapped ???." + _conceptsById[zibId].name + " " + zibId);
            }
        }
    }
});

console.log("zibIds: " + Object.keys(_conceptsById).length + " mapped: " + _zibIdsMapped.length);


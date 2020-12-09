# Check zib mappings to FHIR

## Aspects:

* Short and Alias
* Are all zib elements mapped at least once?
* N.B. Some zibs are mapped to multiple resources
* Cardinalities
* Datatype
* TODO: Coding (DefinitionCode)
    ```
    mapping [ {
    "identity": "sct-attr",
    "uri": "http://snomed.info/sct",
    "name": "SNOMED CT Attribute Binding"
    } ]
    element.mapping [ {
        "identity": "sct-attr",
        "map": "718497002 |Inherent location|"
    } ]
    ```
* TODO: ValueSet
    ```
    element.binding { valueSetReference: { reference, display } }
    ```
* TODO: Url to zibs.nl

## Inputs

* When using FHIR STU3: definitions from http://hl7.org/fhir/STU3/definitions.json.zip
* ZIBS publication in MAX format - get by MAX exporting the ZIBS EAP requested from Nictiz zib-centrum
* **Snapshotted** profiles and associated conformance resources in in JSON format:
    * latest release zibs2017: https://simplifier.net/packages/nictiz.fhir.nl.stu3.zib2017/

## Solution components:

* node.js
* https://github.com/lantanagroup/FHIR.js for validating the profile
* hl7 max and xml2js to read the max zibs2017

## Usage

### Setup

```
> Only when using FHIR STU3: unzip definitions.json.zip -d definitions
> npm update
```

### Run

```
> node index.js -h
```

To see the documentation.

The script can produce two types of output:

* xml: The complete output will be sent to the stdout and can be captured using `> report.xml`. It can then be loaded into a spreadsheet. Additional errors will be reported to stdout.
* text: Only the found issues are reported to stdout.

You can also start a node Docker container and run it there:
```
> docker run -it -v "`pwd`":/app node /bin/bash
```

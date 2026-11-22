export const materialTypes = [
 ['paper','Paper'],['blog','Blog'],['technical-report','Technical report'],['other','Other materials']
];
export const materialType = paper => materialTypes.some(([value])=>value===paper.materialType)?paper.materialType:'paper';
export const materialLabel = paper => materialTypes.find(([value])=>value===materialType(paper))[1];
